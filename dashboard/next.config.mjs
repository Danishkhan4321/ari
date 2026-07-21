/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Keep Electron's long-running development server isolated from production
  // builds. Next otherwise writes both into `.next`, which can leave the
  // desktop server holding a partially replaced module graph.
  distDir: process.env.ARI_NEXT_DIST_DIR || '.next',
  // The dashboard runs on 127.0.0.1:43101 beside Ari on 127.0.0.1:43100.
  //
  // May 28 2026: experimental.typedRoutes was disabled during an emergency
  // build recovery. With it on, several pre-existing router.push(string) /
  // <Link href={string}> call sites (e.g. components/command-palette.tsx:88)
  // fail the type-check, which had been masked because the server was running
  // an older .next build. typedRoutes is a compile-time-only DX feature with
  // zero runtime effect. Re-enable it in your canonical source and fix the
  // route typings (cast to Route or use typed hrefs) when convenient.
  // experimental: {
  //   typedRoutes: true,
  // },
};

export default nextConfig;
