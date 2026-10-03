import { z } from 'zod';
import { ARTICLE_CATEGORIES } from '../types';

// Shared field rules for the briefing text. The Research agent writes these fields,
// the Editor rewrites them, so both validate against the same limits.
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).default('');

export const BriefingFields = z.object({
  headline: text(10, 180),
  summary: text(30, 600),
  what_happened: text(40, 1800),
  why_it_matters: text(20, 1200),
  /** One fact per line, "Label: value". */
  figures_dates: optionalText(1200),
  /** Comma-separated organisations / markets / countries. */
  affected_entities: optionalText(500),
  risks_uncertainty: text(10, 1200),
});
export type BriefingFields = z.infer<typeof BriefingFields>;

export const ResearchOutput = z.object({
  briefings: z
    .array(
      BriefingFields.extend({
        cluster_id: z.string(),
        category: z.enum(ARTICLE_CATEGORIES),
        georgia_related: z.boolean(),
        used_item_ids: z.array(z.string()).min(1),
      }),
    )
    .max(10),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const EditorOutput = z.object({
  articles: z.array(BriefingFields.extend({ id: z.string() })).max(10),
});
export type EditorOutput = z.infer<typeof EditorOutput>;

export const FactCheckOutput = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        claims: z
          .array(
            z.object({
              claim: z.string().max(400),
              verdict: z.enum(['supported', 'unsupported', 'contradicted']),
              source_index: z.number().int().nullable().optional(),
            }),
          )
          .min(1)
          .max(30),
      }),
    )
    .max(10),
});
export type FactCheckOutput = z.infer<typeof FactCheckOutput>;
