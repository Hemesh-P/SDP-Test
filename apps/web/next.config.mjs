/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rat/contracts', '@rat/ui'],
  poweredByHeader: false,
};

export default nextConfig;
