# Container Isolation for Pi Agents

This document describes the Podman-based container isolation implementation for tauroboros.

## Overview

The container isolation feature allows pi agents to run inside Podman containers, providing:

- **Filesystem Isolation**: Agents can only access files within their designated worktree
- **Port Isolation**: Multiple agents can run servers on the same port (e.g., port 3000) without conflict
- **Security**: Standard container sandboxing with dropped capabilities
- **Git Compatibility**: Worktrees function correctly with identical paths inside/outside containers
- **No Special Kernel Requirements**: Works with standard Linux kernels (no gVisor needed)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Host Machine                           │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐ │
│  │ TaurOboros   │  │   Podman    │  │ Git Repository   │ │
│  │   Server     │──│ (daemonless)│──│ /home/user/proj  │ │
│  └──────────────┘  └─────────────┘  └──────────────────┘ │
│          │                                        │         │
│          │ Create container                       │         │
│          │                                        │         │
│          ▼                                        │         │
│  ┌──────────────────────────────────────────────────┐     │
│  │           Container (per agent)                     │     │
│  │  ┌─────────┐  ┌──────────┐                        │     │
│  │  │  Podman │──│  Pi Agent│                        │     │
│  │  │Sandbox  │  │  Process │                        │     │
│  │  └─────────┘  └──────────┘                        │     │
│  │         │                           │              │     │
│  │         │ Volume mounts             │ JSONL RPC    │     │
│  │         │ (same paths)              │ via stdio    │     │
│  │         ▼                           ▼              │     │
│  │  ┌────────────────────────────────────────────────┐     │
│  │  │  Worktree (RW)  │  Repo (RO)  │  Git binary    │     │
│  │  │  /home/user/... │  /home/user │  /usr/bin/git  │     │
│  │  └────────────────────────────────────────────────┘     │
│  └──────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Prerequisites

```bash
# Install Podman (if not already installed)
# Ubuntu/Debian: sudo apt-get install -y podman
# Fedora: sudo dnf install -y podman
# Arch: sudo pacman -S podman
# Or see: https://podman.io/getting-started/installation

# Install and build image
./scripts/setup-e2e-tests.sh
```

### 2. Build the pi-agent Image

```bash
podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .
```

### 3. Verify Setup

```bash
bun run scripts/verify-podman.ts
```

### 4. Enable Container Mode

Edit `.tauroboros/settings.json`:

```json
{
  "workflow": {
    "runtime": {
      "mode": "container"
    },
    "container": {
      "enabled": true
    }
  }
}
```

Or set it per-task via the web UI or API.

## Volume Mounts

The container mounts several directories from your host system using **same-path binding** (paths are identical inside and outside the container):

| Host Path | Container Path | Purpose | Access |
|-----------|---------------|---------|--------|
| `~/.pi/` | `/root/.pi/` | Pi configuration (models.json, auth.json, sessions, cache) | Read-Write |
| `~/.gitconfig` | `/root/.gitconfig` | Git configuration | Read-Only |
| `~/.ssh/` | `/root/.ssh/` | SSH keys for git operations | Read-Only |
| `/usr/bin/git` | `/usr/bin/git` | Git binary | Read-Only |
| `/usr/local/bin/bun` | `/usr/local/bin/bun` | Bun binary | Read-Only |
| Repository root | Same path | Source code (read-only) | Read-Only |
| Worktree directory | Same path | Working directory for task | Read-Write |

**Important:** The `~/.pi/` mount is critical - it contains:
- `models.json` - Your configured AI models and API keys
- `auth.json` - OAuth tokens for authentication
- `sessions/` - Pi session files
- `cache/` - Cached data
- `skills/` - Available skills

## Configuration

Container settings are configured in `.tauroboros/settings.json`:

```json
{
  "workflow": {
    "container": {
      "enabled": false,
      "piBin": "pi",
      "piArgs": "--mode rpc --no-extensions",
      "image": "pi-agent:alpine",
      "memoryMb": 512,
      "cpuCount": 1,
      "portRangeStart": 30000,
      "portRangeEnd": 40000
    }
  }
}
```

### Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `workflow.container.enabled` | `false` | Enable container isolation globally |
| `workflow.container.piBin` | `"pi"` | Path to Pi binary |
| `workflow.container.piArgs` | `"--mode rpc --no-extensions"` | Additional arguments for Pi CLI |
| `workflow.container.image` | `"pi-agent:alpine"` | Podman image for agents |
| `workflow.container.memoryMb` | `512` | Memory limit per container (MB) |
| `workflow.container.cpuCount` | `1` | CPU limit per container |
| `workflow.container.portRangeStart` | `30000` | Start of host port allocation range |
| `workflow.container.portRangeEnd` | `40000` | End of host port allocation range |
| `workflow.container.mountPodmanSocket` | `false` | Mount host's podman socket (enables docker-compose) |

### Task-Level Configuration

```typescript
interface TaskOptions {
  container?: {
    enabled?: boolean
    memoryMb?: number
    cpuCount?: number
    ports?: number[]  // Ports to expose
  }
}
```

## Security Features

The container implementation includes multiple security layers:

- **Podman Security**: Rootless containers by default, no daemon required
- **Dropped Capabilities**: `--cap-drop ALL` removes all Linux capabilities
- **No New Privileges**: `--security-opt no-new-privileges`
- **Read-Only Root**: Repository root is mounted read-only
- **Auto-Remove**: Containers are automatically removed after exit

### Filesystem Isolation Guarantees

| Attack Scenario | Prevention |
|----------------|------------|
| `rm -rf /` | Root filesystem is read-only |
| `rm -rf ~` | Home directory not mounted (except specific paths) |
| Write to other worktrees | Only current worktree is writable |
| Read SSH keys | Mounted read-only, container can't modify |

## Port Isolation

Multiple agents can run development servers on the same port:

```typescript
// Agent 1 runs on port 3000 internally, mapped to host port 30001
// Agent 2 runs on port 3000 internally, mapped to host port 30002
// Agent 3 runs on port 3000 internally, mapped to host port 30003
```

The PortAllocator automatically assigns unique host ports while allowing agents to use their preferred internal ports.

## Container Nesting (Docker Compose Support)

Task containers can run Docker Compose by mounting the host's Podman socket. This is useful for projects that need databases or other services via docker-compose.

### How It Works

The host's Podman socket is mounted into the task container:
- Host path: `/run/user/$UID/podman/podman.sock` (rootless) or `/run/podman/podman.sock` (rootful)
- Container path: `/var/run/docker.sock`
- Environment: `DOCKER_HOST=unix:///var/run/docker.sock`

This allows `docker-compose` inside the container to talk to the host's Podman daemon, which provides a Docker-compatible API.

### Enabling Socket Mounting

Add to your `.tauroboros/settings.json`:

```json
{
  "workflow": {
    "container": {
      "mountPodmanSocket": true
    }
  }
}
```

Or enable per-task via the API when creating a task.

### Prerequisites

1. **Podman socket must be running** on the host:
   ```bash
   # For rootless (most common)
   systemctl --user enable podman.socket
   systemctl --user start podman.socket
   
   # For rootful
   sudo systemctl enable podman.socket
   sudo systemctl start podman.socket
   ```

2. **User must have access** to the socket (rootless mode is recommended).

### Security Warning

**⚠️ Security Trade-off**: Mounting the Podman socket significantly reduces isolation:

- Task containers can see all host containers
- Task containers can start/stop any host container
- Task containers can mount any host path
- One task can interfere with another task's containers

Only enable this when needed for specific tasks. Consider running sensitive tasks without socket mounting.

### Usage in Tasks

When enabled, docker-compose works normally inside the container:

```bash
# Inside the task container
docker-compose up -d postgres
docker-compose ps
docker-compose logs
```

Or programmatically with Python:

```python
import docker
client = docker.DockerClient()
containers = client.containers.list()
```

## Directory Structure Preservation

Git worktrees require identical paths inside and outside the container. The implementation uses **same-path binding**:

```
Host:     /home/user/project/.worktrees/task-abc-123
Container: /home/user/project/.worktrees/task-abc-123  (identical!)
```

This ensures git commands work correctly without path translation issues.

## Testing

### Run E2E Tests

```bash
# Run all container tests
bun test tests/e2e/

# Run specific test suite
bun test tests/e2e/container-lifecycle.test.ts
bun test tests/e2e/filesystem-isolation.test.ts
bun test tests/e2e/rpc-communication.test.ts
bun test tests/e2e/port-isolation.test.ts
```

### Test Prerequisites

Tests are automatically skipped if prerequisites are not met:
- Podman not installed
- pi-agent:alpine image not built

## Troubleshooting

### Podman not available

```bash
# Ubuntu/Debian
sudo apt-get install -y podman

# Fedora
sudo dnf install -y podman

# Arch
sudo pacman -S podman
```

### Image not found

```bash
# Build the pi-agent image
podman build -t pi-agent:alpine -f docker/pi-agent/Dockerfile .
```

### Container fails to start

Check Podman logs:
```bash
podman logs <container-id>
```

### Cleanup

To remove all container configuration:
```bash
./scripts/cleanup-gvisor.sh
```

This will:
- Remove any systemd services we created
- Remove the pi-agent image
- Stop any running containers

## Rollback Strategy

If issues arise, you can quickly disable containers:

1. **Global disable** – Edit `.tauroboros/settings.json`:
   ```json
   {
     "workflow": {
       "runtime": {
         "mode": "native"
       },
       "container": {
         "enabled": false
       }
     }
   }
   ```

2. **Per-task disable** – Via web UI or API.

3. **Emergency stop** command to kill all containers:
   ```typescript
   const orchestrator = new PiOrchestrator(...)
   await orchestrator.emergencyStop()  // Kills all containers
   ```

## Implementation Details

### Key Files

- `src/runtime/container-manager.ts` - Podman container lifecycle management
- `src/runtime/container-pi-process.ts` - Containerized pi process backend
- `src/runtime/pi-process-factory.ts` - Runtime mode selection
- `src/runtime/port-allocator.ts` - Port isolation management
- `docker/pi-agent/Dockerfile` - Agent container image
- `tests/e2e/` - End-to-end tests

### RPC Protocol

The container uses the same JSONL RPC protocol as native mode:

**Client → Agent (stdin)**:
```json
{"type": "prompt", "message": "Create a React app"}
```

**Agent → Client (stdout)**:
```json
{"type": "message_update", "assistantMessageEvent": {"type": "text", "text": "..."}}
{"type": "agent_end"}
```

## References

- [Podman Documentation](https://docs.podman.io/)
- [Pi RPC Mode](https://github.com/mariozechner/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/)
- [Git Worktrees](https://git-scm.com/docs/git-worktree)
