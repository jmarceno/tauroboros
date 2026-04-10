/**
 * E2E Tests: Port Isolation
 *
 * Tests that multiple containers can use the same internal port without conflict.
 */

import { describe, test, expect } from "bun:test"
import { PortAllocator } from "../../src/runtime/port-allocator.ts"

describe("Port Isolation", () => {
  test("allocates unique ports for different sessions", () => {
    const allocator = new PortAllocator(30000, 40000)

    const port1 = allocator.allocatePort("session-1", 3000)
    const port2 = allocator.allocatePort("session-2", 3000)

    expect(port1).not.toBe(port2)
    expect(port1).toBeGreaterThanOrEqual(30000)
    expect(port1).toBeLessThan(40000)
    expect(port2).toBeGreaterThanOrEqual(30000)
    expect(port2).toBeLessThan(40000)
  })

  test("reuses same port for same session and container port", () => {
    const allocator = new PortAllocator(30000, 40000)

    const port1 = allocator.allocatePort("session-1", 3000)
    const port2 = allocator.allocatePort("session-1", 3000)

    // Same session, same container port should get same host port
    expect(port1).toBe(port2)
  })

  test("releases ports when session is done", () => {
    const allocator = new PortAllocator(30000, 40000)

    const port1 = allocator.allocatePort("session-1", 3000)
    allocator.releasePorts("session-1")

    // After releasing, should be able to allocate the same port
    const port2 = allocator.allocatePort("session-2", 3000)
    expect(port2).toBe(port1)
  })

  test("returns port mappings for session", () => {
    const allocator = new PortAllocator(30000, 40000)

    allocator.allocatePort("session-1", 3000)
    allocator.allocatePort("session-1", 8080)

    const mappings = allocator.getPortMappings("session-1")
    expect(mappings).toHaveLength(2)
    expect(mappings.some((m) => m.containerPort === 3000)).toBe(true)
    expect(mappings.some((m) => m.containerPort === 8080)).toBe(true)
  })

  test("throws when port range exhausted", () => {
    const allocator = new PortAllocator(30000, 30002)

    // Exhaust the range
    allocator.allocatePort("session-1", 3000)
    allocator.allocatePort("session-2", 3000)

    // Should throw on third allocation
    expect(() => allocator.allocatePort("session-3", 3000)).toThrow(
      "No available ports",
    )
  })

  test("creates Docker port bindings", () => {
    const allocator = new PortAllocator(30000, 40000)

    const bindings = allocator.createPortBindings("session-1", [3000, 8080])

    expect(bindings["3000/tcp"]).toBeDefined()
    expect(bindings["8080/tcp"]).toBeDefined()
    expect(bindings["3000/tcp"][0].HostPort).toBeDefined()
    expect(bindings["8080/tcp"][0].HostPort).toBeDefined()
  })

  test("tracks allocated port count", () => {
    const allocator = new PortAllocator(30000, 40000)

    expect(allocator.getAllocatedCount()).toBe(0)

    allocator.allocatePort("session-1", 3000)
    expect(allocator.getAllocatedCount()).toBe(1)

    allocator.allocatePort("session-2", 3000)
    expect(allocator.getAllocatedCount()).toBe(2)

    allocator.releasePorts("session-1")
    expect(allocator.getAllocatedCount()).toBe(1)
  })
})
