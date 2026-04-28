import { Request, Response } from 'express';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RESPONSE_TEMPLATES } from './responses.js';

export async function handleChatCompletion(
  req: Request,
  res: Response
): Promise<void> {
  const { messages, stream = false, model = 'fake-model' } = req.body;

  const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';

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

    const systemMessage = new SystemMessage(template.systemPrompt);
    const humanMessage = new HumanMessage(messages.map((m: { content: string }) => m.content).join('\n'));

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
