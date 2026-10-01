import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the parsers and Prisma out of the bundle; they read files at runtime.
  serverExternalPackages: ["pdf-parse", "mammoth", "@prisma/client"],
  // Calibration reads the past-hire CVs and JD files at runtime; ship them
  // with the functions that need them.
  outputFileTracingIncludes: {
    "/insights": ["./data/hires/**/*"],
    "/rubric": ["./data/hires/**/*"],
  },
};

export default nextConfig;
