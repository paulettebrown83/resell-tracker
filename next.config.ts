import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_APP_DEPLOYMENT_ENV: process.env.VERCEL_ENV || 'development' },
};

export default nextConfig;
