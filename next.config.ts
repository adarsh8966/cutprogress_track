import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    // Type errors must fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
  // `next dev` otherwise appends a block to CLAUDE.md on every run. That file
  // is this project's hand-written working agreement and is not a generated
  // artefact, so the injection is turned off rather than committed.
  agentRules: false,
};

export default nextConfig;
