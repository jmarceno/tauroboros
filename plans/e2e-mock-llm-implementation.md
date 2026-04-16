# E2E Test Mock LLM Implementation Plan

**Objective:** Run all e2e tests without calling real LLM APIs by using a TypeScript LangChain-based mock LLM server as an external endpoint. Pi receives a `models.json` with the server's address/port/provider/model configuration.

**Date:** 2026-04-16

---

## Overview

This plan implements a **TypeScript LangChain-based mock LLM server** that runs as a separate process accessible via bridge network (like localhost). Instead of a wrapper inside the container, the mock server is an external service that Pi connects to via `models.json` configuration. The server uses LangChain's `FakeListChatModel` and message content analysis to provide deterministic responses.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Bridge Network (local-like)                       │
│                                                                      │
│  ┌────────────────────────┐           ┌─────────────────────────┐  │
│  │   pi-agent:alpine       │           │   Mock LLM Server       │  │
│  │                         │           │   (Node.js/Bun)         │  │
│  │   ┌──────────────────┐  │           │                         │  │
│  │   │  pi --mode rpc   │──┼──────────▶│  POST /v1/chat/compl     │  │
│  │   │                  │  │  HTTP     │  GET  /v1/models         │  │
│  │   │  models.json     │  │           │  GET  /health           │  │
│  │   │  baseUrl: 9999   │◀─┼───────────│                         │  │
│  │   └──────────────────┘  │           │  • FakeListChatModel   │  │
│  │                          │           │  • LangChain messages  │  │
│  │   Uses RPC via stdin     │           │  • SSE streaming        │  │
│  └──────────────────────────┘           └─────────────────────────┘  │
│           │                                            ▲             │
│           │                                            │             │
│           ▼                                            │             │
│  ┌────────────────────────┐                           │             │
│  │   tauroboros           │                           │             │
│  │   orchestrator        │                           │             │
│  └────────────────────────┘                           │             │
│                                                        │             │
│  ┌────────────────────────┐    ┌─────────────────────┴──────────┐  │
│  │   Host Machine        │    │  Mock Server Container/Process   │  │
│  │   Port: 9999          │◀───┤  (separate from pi-agent)         │  │
│  └────────────────────────┘    └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Difference from Previous Plan:** Instead of starting the mock server inside the pi-agent container via entrypoint wrapper, the mock server runs as a separate external service. Pi connects to it via `models.json` configuration, just like connecting to any other LLM provider.

---

## Core Design Principles

1. **TypeScript Explicitly Required** - All mock server code must be TypeScript with proper type annotations
2. **Maximize LangChain Usage** - Use LangChain abstractions extensively (messages, chains, prompts, output parsers)
3. **External Server** - Mock server is NOT inside the pi-agent container; it's a separate endpoint
4. **Bridge Network Access** - Same as localhost access via Docker bridge network
5. **models.json Configuration** - Pi receives the endpoint address/port/provider/model via models.json

---

## Files to Create

### 1. `mock-llm-server/src/index.ts`

Main entry point for the TypeScript LangChain-based mock LLM server.

```typescript
import express, { Request, Response } from 'express';
import { ChatOpenAI } from 'langchain/openai';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';

const app = express();
app.use(express.json());

// LangChain chain for response generation
const responseChain = RunnableSequence.from([
  PromptTemplate.fromTemplate('Given the user message: {message}\n\nGenerate a mock response that is helpful and concise.'),
  new FakeListChatModel({ responses: ['Mock response'] }),
  new StringOutputParser(),
]);

// Response templates using LangChain
const planPrompt = PromptTemplate.fromTemplate(`
You are a mock planning assistant. Generate a structured plan for: {task}

Respond with a clear multi-phase plan.
`);

const executePrompt = PromptTemplate.fromTemplate(`
You are a mock execution assistant. Task: {task}

Respond with a confirmation of the action you'll take.
`);

const readPrompt = PromptTemplate.fromTemplate(`
You are a mock file reading assistant. Task: {task}

Respond with a confirmation of reading the file content.
`);

const reviewPrompt = PromptTemplate.fromTemplate(`
You are a mock review assistant. Task: {task}

Respond with an evaluation of the work.
`);

// Response categories with LangChain prompts
const responseTemplates = {
  plan: planPrompt,
  execute: executePrompt,
  read: readPrompt,
  review: reviewPrompt,
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}
```

### 2. `mock-llm-server/src/router.ts`

LangChain-based message classification and routing using LangChain chains.

```typescript
import { ChatOpenAI } from 'langchain/openai';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';

const classificationPrompt = PromptTemplate.fromTemplate(`
Classify the following message into one of these categories: plan, execute, read, review, default

Message: {message}

Category (one word only):
`);

const classifierChain = RunnableSequence.from([
  classificationPrompt,
  new FakeListChatModel({ responses: ['default'] }),
  new StringOutputParser(),
]);

export async function classifyMessage(message: string): Promise<string> {
  const category = await classifierChain.invoke({ message });
  return category.toLowerCase().trim();
}
```

### 3. `mock-llm-server/src/responses.ts`

Predefined response templates using LangChain message types.

```typescript
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

export interface ResponseTemplate {
  systemPrompt: string;
  responses: string[];
}

export const RESPONSE_TEMPLATES: Record<string, ResponseTemplate> = {
  plan: {
    systemPrompt: 'You are a planning assistant. Generate structured multi-phase plans.',
    responses: [
      `I'll create a structured plan for this task:

**Phase 1: Setup**
- Create necessary directories
- Initialize configuration files

**Phase 2: Implementation**
- Write core functionality
- Implement required features

**Phase 3: Verification**
- Test the implementation
- Verify output matches requirements`,
    ],
  },
  execute: {
    systemPrompt: 'You are an execution assistant. Confirm file operations and bash commands.',
    responses: [
      "I'll create the requested file with the specified content. Using bash to write the file contents.",
      'Executing the file creation operation now. The file will be written with the provided content.',
    ],
  },
  read: {
    systemPrompt: 'You are a file reading assistant. Confirm reading and verification operations.',
    responses: [
      'Reading the file content... The file exists and contains the expected data. Proceeding with the next steps.',
      'File content verified. The data matches the expected format.',
    ],
  },
  review: {
    systemPrompt: 'You are a review assistant. Evaluate code and provide feedback.',
    responses: [
      `Reviewing the implementation...
✓ All requirements met
✓ Code structure is correct
✓ Output matches expectations

The task is complete and ready.`,
    ],
  },
  default: {
    systemPrompt: 'You are a helpful assistant. Provide concise and useful responses.',
    responses: [
      "I'll help you with this task. Let me analyze the requirements and proceed with the implementation.",
      'Analyzing the request. This is a straightforward task that I can assist with.',
    ],
  },
};
```

### 4. `mock-llm-server/src/openai-endpoint.ts`

OpenAI-compatible endpoint implementation using LangChain streaming.

```typescript
import { Request, Response } from 'express';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RESPONSE_TEMPLATES } from './responses';

export async function handleChatCompletion(
  req: Request,
  res: Response
): Promise<void> {
  const { messages, stream = false, model = 'fake-model' } = req.body;

  const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';

  // Classify message type
  let category = 'default';
  if (lastMessage.includes('plan') || lastMessage.includes('steps')) category = 'plan';
  else if (lastMessage.includes('create') || lastMessage.includes('write') || lastMessage.includes('file')) category = 'execute';
  else if (lastMessage.includes('read') || lastMessage.includes('verify')) category = 'read';
  else if (lastMessage.includes('review') || lastMessage.includes('evaluate')) category = 'review';

  const template = RESPONSE_TEMPLATES[category];
  const fakeModel = new FakeListChatModel({
    responses: template.responses,
  });

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Build system message context
    const systemMessage = new SystemMessage(template.systemPrompt);
    const humanMessage = new HumanMessage(messages.map(m => m.content).join('\n'));

    // Stream response using LangChain
    const streamResult = await fakeModel.stream([systemMessage, humanMessage]);
    
    for await (const chunk of streamResult) {
      const data = `data: ${JSON.stringify({
        choices: [{
          delta: { content: chunk.content },
          finish_reason: null,
        }],
      })}\n\n`;
      res.write(data);
    }

    res.write(`data: ${JSON.stringify({
      choices: [{
        delta: {},
        finish_reason: 'stop',
      }],
    })}\n\n`);
    res.end();
  } else {
    const response = await fakeModel.invoke([new SystemMessage(template.systemPrompt), new HumanMessage(lastMessage)]);
    
    res.json({
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  }
}
```

### 5. `mock-llm-server/src/health.ts`

Health check endpoint using LangChain.

```typescript
import { Request, Response } from 'express';
import { FakeListChatModel } from '@langchain/core/utils/testing';

const healthModel = new FakeListChatModel({ responses: ['ok'] });

export async function handleHealth(req: Request, res: Response): Promise<void> {
  try {
    await healthModel.invoke('health check');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
}
```

### 6. `mock-llm-server/src/models-endpoint.ts`

Models list endpoint.

```typescript
import { Request, Response } from 'express';

export function handleModels(req: Request, res: Response): void {
  res.json({
    object: 'list',
    data: [
      {
        id: 'fake-model',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'mock-server',
        permission: [],
        root: 'fake-model',
        parent: null,
      },
    ],
  });
}
```

### 7. `mock-llm-server/tsconfig.json`

TypeScript configuration.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 8. `mock-llm-server/package.json`

```json
{
  "name": "mock-llm-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@langchain/core": "^0.3.0",
    "express": "^4.18.2",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/node": "^20.10.0",
    "typescript": "^5.3.0",
    "tsx": "^4.7.0"
  }
}
```

### 9. `mock-llm-server/Dockerfile`

Dockerfile for the mock server container.

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

RUN npm run build

EXPOSE 9999

CMD ["npm", "start"]
```

---

## Files to Modify

### 1. `src/runtime/container-manager.ts`

**Changes:**

Add mock server startup and models.json generation for containers:

```typescript
// In createContainer method, after container creation:
const mockServerPort = await this.startMockServerIfNeeded(config);
await this.generateModelsJson(containerId, mockServerPort);

// New method: startMockServerIfNeeded
private async startMockServerIfNeeded(config: ContainerConfig): Promise<number> {
  if (config.useMockLLM) {
    const port = 9999;
    await this.startMockLLMServer(port);
    return port;
  }
  return null;
}

// New method: generateModelsJson
private async generateModelsJson(containerId: string, mockPort: number): Promise<void> {
  const modelsJson = {
    providers: {
      fake: {
        baseUrl: `http://container-ip:${mockPort}/v1`,
        apiKey: 'fake-key-not-used',
        api: 'openai-completions',
        models: [
          {
            id: 'fake-model',
            name: 'Fake Model',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  
  // Copy models.json into container
  await this.copyToContainer(containerId, '/root/.pi/agent/models.json', JSON.stringify(modelsJson));
}
```

### 2. `src/runtime/mock-server-manager.ts` (New file)

Manages the external mock LLM server process.

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';

export class MockServerManager {
  private process: ChildProcess | null = null;
  private port: number;

  constructor(port: number = 9999) {
    this.port = port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn('npm', ['start'], {
        cwd: '/path/to/mock-llm-server',
        stdio: 'pipe',
      });

      // Wait for server to be ready
      const checkReady = setInterval(() => {
        const req = http.get(`http://localhost:${this.port}/health`, (res) => {
          if (res.statusCode === 200) {
            clearInterval(checkReady);
            resolve();
          }
        });
        req.on('error', () => {});
      }, 500);

      this.process.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  getPort(): number {
    return this.port;
  }
}
```

### 3. `tests/e2e/prepare.ts`

**Changes:**

```typescript
// Add mock server manager import
import { MockServerManager } from '../../src/runtime/mock-server-manager';

const mockServerManager = new MockServerManager(9999);

async function setup() {
  // ... existing setup ...
  
  if (useMockLLM) {
    console.log('[PREPARE] Starting external mock LLM server...');
    await mockServerManager.start();
    console.log('[PREPARE] Mock LLM server running on port 9999');
  }
}

async function teardown() {
  if (useMockLLM) {
    await mockServerManager.stop();
  }
  // ... existing teardown ...
}
```

### 4. `playwright.config.ts`

**Changes:**

```typescript
// Add USE_MOCK_LLM passthrough
webServerConfig = {
  command,
  cwd: testProjectDir,
  url: baseURL,
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USE_MOCK_LLM: process.env.USE_MOCK_LLM,
  },
}
```

---

## models.json Configuration for Pi

The key is that pi receives a standard `models.json` that points to the external mock server:

```json
{
  "providers": {
    "fake": {
      "baseUrl": "http://mock-llm-server:9999/v1",
      "apiKey": "fake-key-not-used",
      "api": "openai-completions",
      "models": [
        {
          "id": "fake-model",
          "name": "Fake Model",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

**How it works:**
1. Mock server runs on port 9999 (separate container or host process)
2. Pi-agent container gets `models.json` with `baseUrl: "http://localhost:9999/v1"` (bridge network makes this work like localhost)
3. Pi connects to the mock server just like it would connect to any LLM provider
4. Mock server uses LangChain FakeListChatModel to generate responses

---

## Package.json Scripts to Add

```json
{
  "scripts": {
    "mock-llm-server:build": "cd mock-llm-server && npm install && npm run build",
    "mock-llm-server:start": "cd mock-llm-server && npm start",
    "mock-llm-server:dev": "cd mock-llm-server && npm run dev",
    "test:e2e:mock": "USE_MOCK_LLM=true bun run test:e2e",
    "container:build:mock": "cd mock-llm-server && podman build -t mock-llm-server:latest ."
  }
}
```

---

## Usage Examples

### Run mock LLM server

```bash
# Start the mock server
bun run mock-llm-server:dev

# Or with Docker
podman run -d -p 9999:9999 --name mock-llm mock-llm-server:latest
```

### Run e2e tests with mock LLM

```bash
USE_MOCK_LLM=true bun run test:e2e
```

### Build mock server Docker image

```bash
bun run mock-llm-server:build
podman run -d -p 9999:9999 mock-llm-server:latest
```

---

## LangChain Usage Summary

| Component | Usage in Mock Server |
|-----------|---------------------|
| `FakeListChatModel` | Core response generation |
| `HumanMessage`, `SystemMessage`, `AIMessage` | Message type handling |
| `RunnableSequence` | Chain composition for classification |
| `PromptTemplate` | Structured prompt templates |
| `StringOutputParser` | Parse model output |
| `ChatOpenAI` (mocked) | OpenAI API compatibility layer |

### Why This Approach Uses LangChain Extensively:

1. **Message Abstraction** - LangChain's message types are used throughout for type-safe message handling
2. **Runnable Protocol** - Chains use LangChain's Runnable interface for composability
3. **Prompt Templates** - Response generation uses LangChain prompts for structure
4. **Output Parsers** - Clean separation between model output and final response
5. **Streaming** - LangChain's streaming interface for SSE support

---

## Key Design Decisions

### 1. External Server (Not Wrapper)

**Decision:** Mock server runs as a separate external endpoint, not inside pi-agent container.

**Rationale:**
- Simpler architecture - no entrypoint wrapper needed
- Pi uses standard models.json configuration
- Can run mock server on host or in separate container
- Bridge network makes it localhost-like
- Easier to debug and maintain

### 2. TypeScript Explicitly Required

**Decision:** All mock server code is TypeScript with strict mode.

**Rationale:**
- LangChain is designed for TypeScript
- Better IDE support and type checking
- Catches errors at compile time
- Consistent with project conventions

### 3. LangChain Maximized

**Decision:** Use LangChain abstractions for everything possible.

**Rationale:**
- FakeListChatModel is the core mock mechanism
- Prompts and chains provide structure
- Consistent with project's LangChain usage elsewhere
- Easy to extend with more sophisticated mock behaviors

### 4. Bridge Network Access

**Decision:** Mock server accessible via bridge network like localhost.

**Rationale:**
- Docker bridge network provides localhost-like access
- Pi container can reach mock server via `localhost:9999`
- No need for complex networking configuration
- Works the same as any other LLM provider endpoint

---

## Implementation Phases

### Phase 1: Mock Server Core (Day 1)

- [ ] Create `mock-llm-server/` TypeScript project structure
- [ ] Implement LangChain-based response generation with FakeListChatModel
- [ ] Create OpenAI-compatible `/v1/chat/completions` endpoint
- [ ] Add SSE streaming support for chat completions
- [ ] Implement `/v1/models` and `/health` endpoints
- [ ] Test server standalone locally

### Phase 2: Container/Process Integration (Day 2)

- [ ] Create `MockServerManager` class for process management
- [ ] Add `startMockServerIfNeeded()` to container manager
- [ ] Implement `generateModelsJson()` for container config
- [ ] Test mock server starts with e2e tests

### Phase 3: End-to-End Flow (Day 3)

- [ ] Verify pi connects to mock server via models.json
- [ ] Test full e2e flow with mock responses
- [ ] Tune response content based on test behavior
- [ ] Verify no real API calls are made

### Phase 4: CI Integration (Day 4)

- [ ] Add mock server startup to CI pipeline
- [ ] Test in GitHub Actions environment
- [ ] Verify deterministic test behavior
- [ ] Document usage

---

## Success Criteria

- [ ] All existing e2e tests pass with `USE_MOCK_LLM=true`
- [ ] No real LLM API calls are made during mock test runs
- [ ] Mock server runs as separate external endpoint
- [ ] Pi connects via standard models.json configuration
- [ ] LangChain abstractions used extensively throughout
- [ ] TypeScript strict mode enabled
- [ ] Works in GitHub Actions without API keys
- [ ] Tests are deterministic (same responses each run)

---

## References

- LangChain JS Documentation: https://docs.langchain.com/
- @langchain/core: https://www.npmjs.com/package/@langchain/core
- FakeListChatModel: https://docs.langchain.com/oss/javascript/integrations/chat/fake
- OpenAI API format: https://platform.openai.com/docs/api-reference/chat/create