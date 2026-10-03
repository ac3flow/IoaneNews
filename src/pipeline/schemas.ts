import { z } from 'zod';
import { ARTICLE_CATEGORIES } from '../types';

// Shared field rules for the briefing text. The Research agent writes these fields,
// the Editor rewrites them, so both validate against the same limits.
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).default('');

// `scale` loosens the length limits for Georgian, whose words and case endings run longer.
const fields = (scale: number) =>
  z.object({
    headline: text(10, Math.round(180 * scale)),
    summary: text(30, Math.round(600 * scale)),
    what_happened: text(40, Math.round(1800 * scale)),
    why_it_matters: text(20, Math.round(1200 * scale)),
    /** One fact per line, "Label: value". */
    figures_dates: optionalText(Math.round(1200 * scale)),
    /** Comma-separated organisations / markets / countries. */
    affected_entities: optionalText(Math.round(500 * scale)),
    risks_uncertainty: text(10, Math.round(1200 * scale)),
  });

export const BriefingFields = fields(1);
export type BriefingFields = z.infer<typeof BriefingFields>;

export const GeorgianFields = fields(1.8);
export type GeorgianFields = z.infer<typeof GeorgianFields>;

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

export const TranslationOutput = z.object({
  articles: z.array(GeorgianFields.extend({ id: z.string() })).max(10),
});
export type TranslationOutput = z.infer<typeof TranslationOutput>;

export const KaGrammarOutput = z.object({
  articles: z.array(GeorgianFields.extend({ id: z.string(), corrections: z.string().trim().max(800).default('') })).max(10),
});
export type KaGrammarOutput = z.infer<typeof KaGrammarOutput>;
