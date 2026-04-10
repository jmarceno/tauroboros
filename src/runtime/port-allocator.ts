/**
 * Port Allocator for gVisor container port isolation.
 *
 * Multiple agents can run servers on the same internal port (e.g., 3000)
 * while being mapped to different host ports.
 */
export class PortAllocator {
  private usedPorts = new Set<number>()
  private basePort: number
  private maxPort: number
  private portMappings = new Map<
    string,
    { containerPort: number; hostPort: number }[]
  >()

  constructor(
    basePort: number,
    maxPort: number,
  ) {
    this.basePort = basePort
    this.maxPort = maxPort
  }

  /**
   * Allocate a port for host->container mapping.
   * Returns the host port number to use.
   */
  allocatePort(sessionId: string, containerPort: number): number {
    // Check if this session already has this container port mapped
    const existing = this.portMappings.get(sessionId)
    if (existing) {
      const mapping = existing.find((m) => m.containerPort === containerPort)
      if (mapping) {
        return mapping.hostPort
      }
    }

    // Find an available host port
    for (let port = this.basePort; port < this.maxPort; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port)

        // Store the mapping
        const mappings = this.portMappings.get(sessionId) || []
        mappings.push({ containerPort, hostPort: port })
        this.portMappings.set(sessionId, mappings)

        return port
      }
    }

    throw new Error(
      `No available ports in range ${this.basePort}-${this.maxPort}`,
    )
  }

  /**
   * Release all ports allocated for a session.
   */
  releasePorts(sessionId: string): void {
    const mappings = this.portMappings.get(sessionId)
    if (mappings) {
      for (const mapping of mappings) {
        this.usedPorts.delete(mapping.hostPort)
      }
      this.portMappings.delete(sessionId)
    }
  }

  /**
   * Release a specific port.
   */
  releasePort(port: number): void {
    this.usedPorts.delete(port)

    // Remove from any session mappings
    for (const [sessionId, mappings] of this.portMappings.entries()) {
      const filtered = mappings.filter((m) => m.hostPort !== port)
      if (filtered.length === 0) {
        this.portMappings.delete(sessionId)
      } else if (filtered.length !== mappings.length) {
        this.portMappings.set(sessionId, filtered)
      }
    }
  }

  /**
   * Get all port mappings for a session.
   */
  getPortMappings(
    sessionId: string,
  ): { containerPort: number; hostPort: number }[] {
    return this.portMappings.get(sessionId) || []
  }

  /**
   * Check if a port is in use.
   */
  isPortUsed(port: number): boolean {
    return this.usedPorts.has(port)
  }

  /**
   * Get the count of allocated ports.
   */
  getAllocatedCount(): number {
    return this.usedPorts.size
  }

  /**
   * Create port bindings for Docker container configuration.
   */
  createPortBindings(
    sessionId: string,
    containerPorts: number[],
  ): Record<string, { HostPort: string }[]> {
    const bindings: Record<string, { HostPort: string }[]> = {}

    for (const containerPort of containerPorts) {
      const hostPort = this.allocatePort(sessionId, containerPort)
      bindings[`${containerPort}/tcp`] = [{ HostPort: hostPort.toString() }]
    }

    return bindings
  }
}
