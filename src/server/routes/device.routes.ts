/**
 * 设备管理相关路由
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { DeviceRegisterData } from "../../types/device.types.ts";
import { config } from "../config.js";
import { isHomeHostname, isHomeNetwork } from "../utils/network.utils.js";

export async function deviceRoutes(fastify: FastifyInstance, prisma: PrismaClient) {
    let cachedServerPublicIps: string[] = [];
    let cachedServerPublicIpsAt = 0;

    const normalizeIp = (value: string) => {
        const trimmed = value.trim();
        if (trimmed.startsWith("::ffff:")) {
            return trimmed.substring(7);
        }

        return trimmed;
    };

    const resolveClientIp = (request: FastifyRequest) => {
        const cfConnectingIp = request.headers["cf-connecting-ip"];
        if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
            return cfConnectingIp.trim();
        }

        const xForwardedFor = request.headers["x-forwarded-for"];
        if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
            return xForwardedFor.split(",")[0]!.trim();
        }

        const xRealIp = request.headers["x-real-ip"];
        if (typeof xRealIp === "string" && xRealIp.trim()) {
            return xRealIp.trim();
        }

        return request.ip;
    };

    const resolveRequestHostname = (request: FastifyRequest) => {
        const hostHeader = request.headers.host;
        if (typeof hostHeader === "string" && hostHeader.trim()) {
            return hostHeader.split(":")[0]!.trim().toLowerCase();
        }

        return "";
    };

    const fetchServerPublicIp = async (url: string) => {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
            throw new Error(`Public IP lookup failed with status ${response.status}`);
        }

        return normalizeIp((await response.text()).trim());
    };

    const resolveHomePublicIps = async () => {
        const now = Date.now();
        if (cachedServerPublicIps.length > 0 && now - cachedServerPublicIpsAt < config.network.publicIpCacheMs) {
            return cachedServerPublicIps;
        }

        const configuredIps = config.network.homePublicIps.map(normalizeIp);
        const discoveredIps = new Set<string>(configuredIps);

        for (const endpoint of ["https://api.ipify.org", "https://ipv4.icanhazip.com"]) {
            try {
                const ip = await fetchServerPublicIp(endpoint);
                if (ip) {
                    discoveredIps.add(ip);
                }
            } catch (error) {
                fastify.log.warn({ error, endpoint }, "Failed to resolve server public IP");
            }
        }

        cachedServerPublicIps = Array.from(discoveredIps);
        cachedServerPublicIpsAt = now;
        return cachedServerPublicIps;
    };

    // Network check endpoint
    fastify.get("/network-check", async (request, reply) => {
        const clientIp = normalizeIp(resolveClientIp(request));
        const requestHostname = resolveRequestHostname(request);
        const homePublicIps = await resolveHomePublicIps();
        const isHomeByClientIp = isHomeNetwork(clientIp);
        const isHomeByHostname = isHomeHostname(requestHostname);
        const isHomeByPublicIp = homePublicIps.includes(clientIp);
        const isHome = isHomeByClientIp || isHomeByHostname || isHomeByPublicIp;

        return {
            isHome,
            clientIp,
            requestHostname,
            homePublicIps,
            detection: {
                isHomeByClientIp,
                isHomeByHostname,
                isHomeByPublicIp,
            },
        };
    });

    // 设备注册接口
    fastify.post("/register", {
        schema: {
            description: "注册或更新设备信息",
            tags: ["device"],
            body: {
                type: "object",
                required: ["serial_no"],
                properties: {
                    serial_no: { type: "string", description: "设备序列号" },
                    android_id: { type: "string", description: "Android ID" },
                    boot_id: { type: "string", description: "启动ID" },
                    ble_mac: { type: "string", description: "蓝牙MAC地址" },
                    model: { type: "string", description: "设备型号" },
                    market_name: { type: "string", description: "设备市场名称" },
                    version: { type: "string", description: "Android系统版本" },
                    kernel_ver: { type: "string", description: "内核版本" },
                    adb_enabled: { type: "string", description: "ADB是否启用" },
                    adb_port: { type: "string", description: "ADB端口号" },
                    adb_status: { type: "string", description: "ADB守护进程状态" },
                    adb_pid: { type: "string", description: "ADB守护进程PID" },
                    iface: { type: "string", description: "网络接口名称" },
                    src_ip: { type: "string", description: "源IP地址" },
                    iface_ip: { type: "string", description: "网络接口IP地址" }
                }
            }
        }
    }, async (request: FastifyRequest<{ Body: DeviceRegisterData }>, reply) => {
        try {
            const { serial_no, ...devicePayload } = request.body;

            const device = await prisma.device.upsert({
                where: { serial_no },
                update: devicePayload,
                create: { serial_no, ...devicePayload }
            });

            request.log.info({ deviceId: device.id, serial: device.serial_no }, "Device registered");

            return {
                success: true,
                message: "Device registered successfully",
                data: device.id
            };
        } catch (error) {
            request.log.error(error, "Failed to register device");

            return reply.code(500).send({
                success: false,
                message: "Internal server error",
                error: error instanceof Error ? error.message : "Unknown error"
            });
        }
    });

    // 获取所有已注册设备
    fastify.get("/devices/registered", {
        schema: {
            description: "获取所有已注册的设备列表",
            tags: ["device"],
            querystring: {
                type: "object",
                properties: {
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: config.pagination.maxLimit,
                        default: config.pagination.defaultLimit,
                        description: "返回数量限制"
                    },
                    offset: {
                        type: "integer",
                        minimum: 0,
                        default: 0,
                        description: "偏移量"
                    }
                }
            }
        }
    }, async (request: FastifyRequest<{ Querystring: { limit?: number; offset?: number } }>, reply) => {
        try {
            const {
                limit = config.pagination.defaultLimit,
                offset = 0
            } = request.query;

            const [total, devices] = await Promise.all([
                prisma.device.count(),
                prisma.device.findMany({
                    orderBy: { updatedAt: 'desc' },
                    take: limit,
                    skip: offset
                })
            ]);

            request.log.info({ total, limit, offset }, "Retrieved device list");

            return {
                success: true,
                total,
                data: devices
            };
        } catch (error) {
            request.log.error(error, "Failed to get device list");

            return reply.code(500).send({
                success: false,
                message: "Internal server error"
            });
        }
    });
}

