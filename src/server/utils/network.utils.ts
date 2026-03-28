const normalizeIp = (value: string): string => {
    if (value.startsWith("::ffff:")) {
        return value.substring(7);
    }

    return value;
};

export const isHomeNetwork = (ip: string): boolean => {
    const normalizedIp = normalizeIp(ip.trim());

    if (normalizedIp === "127.0.0.1" || normalizedIp === "::1" || normalizedIp === "localhost") {
        return true;
    }

    return normalizedIp.startsWith("192.168.50.");
};

export const isHomeHostname = (hostname: string): boolean => {
    const normalizedHost = normalizeIp(hostname.trim().toLowerCase());

    if (!normalizedHost) {
        return false;
    }

    if (normalizedHost === "localhost") {
        return true;
    }

    return normalizedHost.startsWith("192.168.50.");
};
