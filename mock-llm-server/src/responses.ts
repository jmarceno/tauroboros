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