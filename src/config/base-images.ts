export const BASE_IMAGES = {
  debian: process.env.DEBIAN_BASE_IMAGE || "debian:trixie-slim",
  piAgent: "pi-agent:latest",
  mockLlm: "mock-llm-server:latest",
  testRunner: "test-runner:latest",
} as const

export const CONTAINER_DEFAULTS = {
  networkMode: "bridge",
  memoryMb: 512,
  cpuCount: 1,
} as const