import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生成的软件通过沙箱运行，预览走服务端代理，此处不需要额外配置
  reactStrictMode: true,
};

export default nextConfig;