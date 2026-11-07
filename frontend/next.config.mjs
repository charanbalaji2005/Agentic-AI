/** @type {import('next').NextConfig} */
const BACKEND_URL = process.env.INTERNAL_BACKEND_URL || "http://127.0.0.1:8000";

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/chat/:path*", destination: `${BACKEND_URL}/api/chat/:path*` },
      { source: "/api/chat", destination: `${BACKEND_URL}/api/chat` },
      { source: "/api/models/:path*", destination: `${BACKEND_URL}/api/models/:path*` },
      { source: "/api/models", destination: `${BACKEND_URL}/api/models` },
      { source: "/api/kb/:path*", destination: `${BACKEND_URL}/api/kb/:path*` },
      { source: "/api/kb", destination: `${BACKEND_URL}/api/kb` },
      { source: "/api/agents/:path*", destination: `${BACKEND_URL}/api/agents/:path*` },
      { source: "/api/agents", destination: `${BACKEND_URL}/api/agents` },
      { source: "/api/conversations/:path*", destination: `${BACKEND_URL}/api/conversations/:path*` },
      { source: "/api/conversations", destination: `${BACKEND_URL}/api/conversations` },
      { source: "/api/system/:path*", destination: `${BACKEND_URL}/api/system/:path*` },
      { source: "/api/system", destination: `${BACKEND_URL}/api/system` },
      { source: "/api/export/:path*", destination: `${BACKEND_URL}/api/export/:path*` },
      { source: "/api/export", destination: `${BACKEND_URL}/api/export` },
    ];
  },
};

export default nextConfig;
