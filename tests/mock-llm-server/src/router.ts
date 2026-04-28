import { FakeListChatModel } from '@langchain/core/utils/testing';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { PROMPT_CATALOG, joinPrompt } from '../../src/backend-ts/prompts/catalog.ts';

const classificationPrompt = PromptTemplate.fromTemplate(joinPrompt(PROMPT_CATALOG.mockClassificationPromptLines));

const classifierChain = RunnableSequence.from([
  classificationPrompt,
  new FakeListChatModel({ responses: ['default'] }),
  new StringOutputParser(),
]);

export async function classifyMessage(message: string): Promise<string> {
  const category = await classifierChain.invoke({ message });
  return category.toLowerCase().trim();
}
