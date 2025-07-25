import { desc, eq, and, sql } from 'drizzle-orm';
import NodeCache from 'node-cache';
import { getDb } from '../database';
import {
  datasetsTable,
  evalsTable,
  evalsToDatasetsTable,
  evalsToPromptsTable,
  evalsToTagsTable,
  promptsTable,
  tagsTable,
  evalResultsTable,
} from '../database/tables';
import { getAuthor } from '../globalConfig/accounts';
import logger from '../logger';
import Eval, { createEvalId } from '../models/eval';
import { generateIdFromPrompt } from '../models/prompt';
import {
  type EvalWithMetadata,
  type EvaluateTable,
  type PromptWithMetadata,
  type ResultsFile,
  type TestCasesWithMetadata,
  type TestCasesWithMetadataPrompt,
  type UnifiedConfig,
  type CompletedPrompt,
  type EvaluateSummaryV2,
} from '../types';
import invariant from '../util/invariant';
import { sha256 } from './createHash';

const DEFAULT_QUERY_LIMIT = 100;

export async function writeResultsToDatabase(
  results: EvaluateSummaryV2,
  config: Partial<UnifiedConfig>,
  createdAt: Date = new Date(),
): Promise<string> {
  createdAt = createdAt || (results.timestamp ? new Date(results.timestamp) : new Date());
  const evalId = createEvalId(createdAt);
  const db = getDb();

  const promises = [];
  promises.push(
    db
      .insert(evalsTable)
      .values({
        id: evalId,
        createdAt: createdAt.getTime(),
        author: getAuthor(),
        description: config.description,
        config,
        results,
      })
      .onConflictDoNothing()
      .run(),
  );

  logger.debug(`Inserting eval ${evalId}`);

  // Record prompt relation
  invariant(results.table, 'Table is required');

  for (const prompt of results.table.head.prompts) {
    const label = prompt.label || prompt.display || prompt.raw;
    const promptId = generateIdFromPrompt(prompt);

    promises.push(
      db
        .insert(promptsTable)
        .values({
          id: promptId,
          prompt: label,
        })
        .onConflictDoNothing()
        .run(),
    );

    promises.push(
      db
        .insert(evalsToPromptsTable)
        .values({
          evalId,
          promptId,
        })
        .onConflictDoNothing()
        .run(),
    );

    logger.debug(`Inserting prompt ${promptId}`);
  }

  // Record dataset relation
  const datasetId = sha256(JSON.stringify(config.tests || []));
  const testsForStorage = Array.isArray(config.tests) ? config.tests : [];

  // Log when non-array tests are converted to empty array for database storage
  if (config.tests && !Array.isArray(config.tests)) {
    const testsType = typeof config.tests;
    const hasPath =
      typeof config.tests === 'object' && config.tests !== null && 'path' in config.tests;
    logger.debug(
      `Converting non-array test configuration to empty array for database storage. Type: ${testsType}, hasPath: ${hasPath}`,
    );
  }

  promises.push(
    db
      .insert(datasetsTable)
      .values({
        id: datasetId,
        tests: testsForStorage,
      })
      .onConflictDoNothing()
      .run(),
  );

  promises.push(
    db
      .insert(evalsToDatasetsTable)
      .values({
        evalId,
        datasetId,
      })
      .onConflictDoNothing()
      .run(),
  );

  logger.debug(`Inserting dataset ${datasetId}`);

  // Record tags
  if (config.tags) {
    for (const [tagKey, tagValue] of Object.entries(config.tags)) {
      const tagId = sha256(`${tagKey}:${tagValue}`);

      promises.push(
        db
          .insert(tagsTable)
          .values({
            id: tagId,
            name: tagKey,
            value: tagValue,
          })
          .onConflictDoNothing()
          .run(),
      );

      promises.push(
        db
          .insert(evalsToTagsTable)
          .values({
            evalId,
            tagId,
          })
          .onConflictDoNothing()
          .run(),
      );

      logger.debug(`Inserting tag ${tagId}`);
    }
  }

  logger.debug(`Awaiting ${promises.length} promises to database...`);
  await Promise.all(promises);

  return evalId;
}

export async function readResult(
  id: string,
): Promise<{ id: string; result: ResultsFile; createdAt: Date } | undefined> {
  try {
    const eval_ = await Eval.findById(id);
    invariant(eval_, `Eval with ID ${id} not found.`);
    return {
      id,
      result: await eval_.toResultsFile(),
      createdAt: new Date(eval_.createdAt),
    };
  } catch (err) {
    logger.error(`Failed to read result with ID ${id} from database:\n${err}`);
  }
}

export async function updateResult(
  id: string,
  newConfig?: Partial<UnifiedConfig>,
  newTable?: EvaluateTable,
): Promise<void> {
  try {
    // Fetch the existing eval data from the database
    const existingEval = await Eval.findById(id);

    if (!existingEval) {
      logger.error(`Eval with ID ${id} not found.`);
      return;
    }

    if (newConfig) {
      existingEval.config = newConfig;
    }
    if (newTable) {
      existingEval.setTable(newTable);
    }

    await existingEval.save();

    logger.info(`Updated eval with ID ${id}`);
  } catch (err) {
    logger.error(`Failed to update eval with ID ${id}:\n${err}`);
  }
}

export async function getLatestEval(filterDescription?: string): Promise<ResultsFile | undefined> {
  const eval_ = await Eval.latest();
  return await eval_?.toResultsFile();
}

export async function getPromptsWithPredicate(
  predicate: (result: ResultsFile) => boolean,
  limit: number,
): Promise<PromptWithMetadata[]> {
  // TODO(ian): Make this use a proper database query
  const evals_ = await Eval.getMany(limit);

  const groupedPrompts: { [hash: string]: PromptWithMetadata } = {};

  for (const eval_ of evals_) {
    const createdAt = new Date(eval_.createdAt).toISOString();
    const resultWrapper: ResultsFile = await eval_.toResultsFile();
    if (predicate(resultWrapper)) {
      for (const prompt of eval_.getPrompts()) {
        const promptId = sha256(prompt.raw);
        const datasetId = resultWrapper.config.tests
          ? sha256(JSON.stringify(resultWrapper.config.tests))
          : '-';
        if (promptId in groupedPrompts) {
          groupedPrompts[promptId].recentEvalDate = new Date(
            Math.max(
              groupedPrompts[promptId].recentEvalDate.getTime(),
              new Date(createdAt).getTime(),
            ),
          );
          groupedPrompts[promptId].count += 1;
          groupedPrompts[promptId].evals.push({
            id: eval_.id,
            datasetId,
            metrics: prompt.metrics,
          });
        } else {
          groupedPrompts[promptId] = {
            count: 1,
            id: promptId,
            prompt,
            recentEvalDate: new Date(createdAt),
            recentEvalId: eval_.id,
            evals: [
              {
                id: eval_.id,
                datasetId,
                metrics: prompt.metrics,
              },
            ],
          };
        }
      }
    }
  }

  return Object.values(groupedPrompts);
}

export function getPromptsForTestCasesHash(
  testCasesSha256: string,
  limit: number = DEFAULT_QUERY_LIMIT,
) {
  return getPromptsWithPredicate((result) => {
    const testsJson = JSON.stringify(result.config.tests);
    const hash = sha256(testsJson);
    return hash === testCasesSha256;
  }, limit);
}

export async function getTestCasesWithPredicate(
  predicate: (result: ResultsFile) => boolean,
  limit: number,
): Promise<TestCasesWithMetadata[]> {
  const evals_ = await Eval.getMany(limit);

  const groupedTestCases: { [hash: string]: TestCasesWithMetadata } = {};

  for (const eval_ of evals_) {
    const createdAt = new Date(eval_.createdAt).toISOString();
    const resultWrapper: ResultsFile = await eval_.toResultsFile();
    const testCases = resultWrapper.config.tests;
    if (testCases && predicate(resultWrapper)) {
      const evalId = eval_.id;
      // For database storage, we need to handle the union type properly
      // Only store actual test case arrays, not generator configs
      let storableTestCases: string | Array<string | any>;
      if (typeof testCases === 'string') {
        storableTestCases = testCases;
      } else if (Array.isArray(testCases)) {
        storableTestCases = testCases;
      } else {
        // If it's a TestGeneratorConfig object, we can't store it directly
        // This case should be rare as the database typically stores resolved tests
        logger.warn('Skipping TestGeneratorConfig object in database storage');
        continue;
      }
      const datasetId = sha256(JSON.stringify(storableTestCases));

      if (datasetId in groupedTestCases) {
        groupedTestCases[datasetId].recentEvalDate = new Date(
          Math.max(groupedTestCases[datasetId].recentEvalDate.getTime(), eval_.createdAt),
        );
        groupedTestCases[datasetId].count += 1;
        const newPrompts = eval_.getPrompts().map((prompt) => ({
          id: sha256(prompt.raw),
          prompt,
          evalId,
        }));
        const promptsById: Record<string, TestCasesWithMetadataPrompt> = {};
        for (const prompt of groupedTestCases[datasetId].prompts.concat(newPrompts)) {
          if (!(prompt.id in promptsById)) {
            promptsById[prompt.id] = prompt;
          }
        }
        groupedTestCases[datasetId].prompts = Object.values(promptsById);
      } else {
        const newPrompts = eval_.getPrompts().map((prompt) => ({
          id: sha256(prompt.raw),
          prompt,
          evalId,
        }));
        const promptsById: Record<string, TestCasesWithMetadataPrompt> = {};
        for (const prompt of newPrompts) {
          if (!(prompt.id in promptsById)) {
            promptsById[prompt.id] = prompt;
          }
        }
        groupedTestCases[datasetId] = {
          id: datasetId,
          count: 1,
          testCases: storableTestCases,
          recentEvalDate: new Date(createdAt),
          recentEvalId: evalId,
          prompts: Object.values(promptsById),
        };
      }
    }
  }

  return Object.values(groupedTestCases);
}

export function getPrompts(limit: number = DEFAULT_QUERY_LIMIT) {
  return getPromptsWithPredicate(() => true, limit);
}

export async function getTestCases(limit: number = DEFAULT_QUERY_LIMIT) {
  return getTestCasesWithPredicate(() => true, limit);
}

export async function getPromptFromHash(hash: string) {
  const prompts = await getPrompts();
  for (const prompt of prompts) {
    if (prompt.id.startsWith(hash)) {
      return prompt;
    }
  }
  return undefined;
}

export async function getDatasetFromHash(hash: string) {
  const datasets = await getTestCases();
  for (const dataset of datasets) {
    if (dataset.id.startsWith(hash)) {
      return dataset;
    }
  }
  return undefined;
}

export async function getEvalsWithPredicate(
  predicate: (result: ResultsFile) => boolean,
  limit: number,
): Promise<EvalWithMetadata[]> {
  const db = getDb();
  const evals_ = await db
    .select({
      id: evalsTable.id,
      createdAt: evalsTable.createdAt,
      author: evalsTable.author,
      results: evalsTable.results,
      config: evalsTable.config,
      description: evalsTable.description,
    })
    .from(evalsTable)
    .orderBy(desc(evalsTable.createdAt))
    .limit(limit)
    .all();

  const ret: EvalWithMetadata[] = [];

  for (const eval_ of evals_) {
    const createdAt = new Date(eval_.createdAt).toISOString();
    const resultWrapper: ResultsFile = {
      version: 3,
      createdAt,
      author: eval_.author,
      // @ts-ignore
      results: eval_.results,
      config: eval_.config,
    };
    if (predicate(resultWrapper)) {
      const evalId = eval_.id;
      ret.push({
        id: evalId,
        date: new Date(eval_.createdAt),
        config: eval_.config,
        // @ts-ignore
        results: eval_.results,
        description: eval_.description || undefined,
      });
    }
  }

  return ret;
}

export async function getEvals(limit: number = DEFAULT_QUERY_LIMIT) {
  return getEvalsWithPredicate(() => true, limit);
}

export async function getEvalFromId(hash: string) {
  const evals_ = await getEvals();
  for (const eval_ of evals_) {
    if (eval_.id.startsWith(hash)) {
      return eval_;
    }
  }
  return undefined;
}

export async function deleteEval(evalId: string) {
  const db = getDb();
  db.transaction(() => {
    // We need to clean up foreign keys first. We don't have onDelete: 'cascade' set on all these relationships.
    db.delete(evalsToPromptsTable).where(eq(evalsToPromptsTable.evalId, evalId)).run();
    db.delete(evalsToDatasetsTable).where(eq(evalsToDatasetsTable.evalId, evalId)).run();
    db.delete(evalsToTagsTable).where(eq(evalsToTagsTable.evalId, evalId)).run();
    db.delete(evalResultsTable).where(eq(evalResultsTable.evalId, evalId)).run();

    // Finally, delete the eval record
    const deletedIds = db.delete(evalsTable).where(eq(evalsTable.id, evalId)).run();
    if (deletedIds.changes === 0) {
      throw new Error(`Eval with ID ${evalId} not found`);
    }
  });
}

/**
 * Deletes all evaluations and related records with foreign keys from the database.
 * @async
 * @returns {Promise<void>}
 */
export async function deleteAllEvals(): Promise<void> {
  const db = getDb();
  db.transaction(() => {
    db.delete(evalResultsTable).run();
    db.delete(evalsToPromptsTable).run();
    db.delete(evalsToDatasetsTable).run();
    db.delete(evalsToTagsTable).run();
    db.delete(evalsTable).run();
  });
}

export type StandaloneEval = CompletedPrompt & {
  evalId: string;
  description: string | null;
  datasetId: string | null;
  promptId: string | null;
  isRedteam: boolean;
  createdAt: number;

  pluginFailCount: Record<string, number>;
  pluginPassCount: Record<string, number>;
  uuid: string;
};

const standaloneEvalCache = new NodeCache({ stdTTL: 60 * 60 * 2 }); // Cache for 2 hours

export async function getStandaloneEvals({
  limit = DEFAULT_QUERY_LIMIT,
  tag,
  description,
}: {
  limit?: number;
  tag?: { key: string; value: string };
  description?: string;
} = {}): Promise<StandaloneEval[]> {
  const cacheKey = `standalone_evals_${limit}_${tag?.key}_${tag?.value}`;
  const cachedResult = standaloneEvalCache.get<StandaloneEval[]>(cacheKey);

  if (cachedResult) {
    return cachedResult;
  }

  const db = getDb();
  const results = db
    .select({
      evalId: evalsTable.id,
      description: evalsTable.description,
      results: evalsTable.results,
      createdAt: evalsTable.createdAt,
      promptId: evalsToPromptsTable.promptId,
      datasetId: evalsToDatasetsTable.datasetId,
      tagName: tagsTable.name,
      tagValue: tagsTable.value,
      isRedteam: sql`json_extract(evals.config, '$.redteam') IS NOT NULL`.as('isRedteam'),
    })
    .from(evalsTable)
    .leftJoin(evalsToPromptsTable, eq(evalsTable.id, evalsToPromptsTable.evalId))
    .leftJoin(evalsToDatasetsTable, eq(evalsTable.id, evalsToDatasetsTable.evalId))
    .leftJoin(evalsToTagsTable, eq(evalsTable.id, evalsToTagsTable.evalId))
    .leftJoin(tagsTable, eq(evalsToTagsTable.tagId, tagsTable.id))
    .where(
      and(
        tag ? and(eq(tagsTable.name, tag.key), eq(tagsTable.value, tag.value)) : undefined,
        description ? eq(evalsTable.description, description) : undefined,
      ),
    )
    .orderBy(desc(evalsTable.createdAt))
    .limit(limit)
    .all();

  // TODO(Performance): Load all necessary data in one go rather than re-requesting each eval!
  const standaloneEvals = (
    await Promise.all(
      results.map(async (result) => {
        const {
          description,
          createdAt,
          evalId,
          promptId,
          datasetId,
          // @ts-ignore
          isRedteam,
        } = result;
        const eval_ = await Eval.findById(evalId);
        invariant(eval_, `Eval with ID ${evalId} not found`);
        const table = (await eval_.getTable()) || { body: [] };
        // @ts-ignore
        return eval_.getPrompts().map((col, index) => {
          // Compute some stats
          const pluginCounts = table.body.reduce(
            // @ts-ignore
            (acc, row) => {
              const pluginId = row.test.metadata?.pluginId;
              if (pluginId) {
                const isPass = row.outputs[index].pass;
                acc.pluginPassCount[pluginId] =
                  (acc.pluginPassCount[pluginId] || 0) + (isPass ? 1 : 0);
                acc.pluginFailCount[pluginId] =
                  (acc.pluginFailCount[pluginId] || 0) + (isPass ? 0 : 1);
              }
              return acc;
            },
            { pluginPassCount: {}, pluginFailCount: {} } as {
              pluginPassCount: Record<string, number>;
              pluginFailCount: Record<string, number>;
            },
          );

          return {
            evalId,
            description,
            promptId,
            datasetId,
            createdAt,
            isRedteam: isRedteam as boolean,
            ...pluginCounts,
            ...col,
          };
        });
      }),
    )
  ).flat();

  // Ensure each row has a UUID as the `id` and `evalId` properties are not unique!
  const withUUIDs = standaloneEvals.map((eval_) => ({
    ...eval_,
    uuid: crypto.randomUUID(),
  }));

  standaloneEvalCache.set(cacheKey, withUUIDs);
  return withUUIDs;
}
