import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from "path"
import fs from "fs"

// https://vite.dev/config/
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'https://127.0.0.1:8080'

export default defineConfig({
    plugins: [react(), tailwindcss(),],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    /* scrcpy */
    server: {
        https: fs.existsSync(path.resolve(__dirname, './certs/key.pem')) ? {
            key: fs.readFileSync(path.resolve(__dirname, './certs/key.pem')),
            cert: fs.readFileSync(path.resolve(__dirname, './certs/cert.pem')),
        } : undefined,
        fs: {
            allow: ["../.."],
        },
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        proxy: {
            '/api': {
                target: apiProxyTarget,
                changeOrigin: true,
                secure: false,
                ws: true,
            },
        },
    },
    optimizeDeps: {
        exclude: [
            "@yume-chan/scrcpy-decoder-tinyh264",
            "@yume-chan/pcm-player",
        ],
        include: [
            "@yume-chan/scrcpy-decoder-tinyh264 > yuv-buffer",
            "@yume-chan/scrcpy-decoder-tinyh264 > yuv-canvas",
        ],
    },
    worker: {
        format: 'es',
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes("@yume-chan") || id.includes("tinyh264")) {
                        return "scrcpy-vendor";
                    }
                    if (id.includes("react-router") || id.includes("react-dom") || id.includes("react/jsx-runtime")) {
                        return "react-vendor";
                    }
                    if (id.includes("lucide-react") || id.includes("/components/ui/")) {
                        return "ui-vendor";
                    }
                    return undefined;
                },
            },
        },
    },
})
