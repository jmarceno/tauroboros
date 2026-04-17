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
