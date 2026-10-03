import { describe, expect, it } from 'vitest';
import { groundChart, groundTranslatedChart } from '../src/pipeline/chart';
import { ChartData } from '../src/pipeline/schemas';

const SOURCE = 'Broadcom is lining up a $60 billion financing package. Revenue could reach $115 billion in fiscal 2027 and $230 billion in 2028. Rate 4.25 percent, flows 1,200 million.';
const chart = (items: { label: string; value: number }[], extra: Record<string, unknown> = {}) => ChartData.parse({ title: 'Broadcom AI revenue forecast', unit: '$ billion', items, ...extra });

describe('groundChart (English chart from Research)', () => {
  it('keeps a chart whose values and label numbers all appear in the source text', () => {
    const c = chart([{ label: 'Fiscal 2027', value: 115 }, { label: 'Fiscal 2028', value: 230 }]);
    expect(groundChart(c, SOURCE)).toEqual(c);
  });

  it('matches figures however they are written: 4.250 and 1,200', () => {
    expect(groundChart(chart([{ label: 'Rate', value: 4.25 }, { label: 'Flows', value: 1200 }]), SOURCE)).not.toBeNull();
  });

  it('drops a chart with a value the sources never state, even if only one bar is invented', () => {
    expect(groundChart(chart([{ label: 'Fiscal 2027', value: 115 }, { label: 'Fiscal 2029', value: 460 }]), SOURCE)).toBeNull();
  });

  it('drops a chart whose label or title carries an invented number', () => {
    expect(groundChart(chart([{ label: 'Fiscal 2031', value: 115 }, { label: 'Fiscal 2028', value: 230 }]), SOURCE)).toBeNull();
    expect(groundChart(chart([{ label: 'A', value: 115 }, { label: 'B', value: 230 }], { title: 'Outlook 2040' }), SOURCE)).toBeNull();
  });

  it('drops duplicate labels, and passes nothing through', () => {
    expect(groundChart(chart([{ label: 'Same', value: 115 }, { label: 'same', value: 230 }]), SOURCE)).toBeNull();
    expect(groundChart(null, SOURCE)).toBeNull();
    expect(groundChart(undefined, SOURCE)).toBeNull();
  });

  it('a negative bar is judged by its magnitude', () => {
    expect(groundChart(chart([{ label: 'Down', value: -60 }, { label: 'Up', value: 115 }]), SOURCE)).not.toBeNull();
  });
});

describe('ChartData validation', () => {
  it('needs two to six items and finite numbers', () => {
    expect(ChartData.safeParse({ title: 'Title', items: [{ label: 'a', value: 1 }] }).success).toBe(false);
    expect(ChartData.safeParse({ title: 'Title', items: Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, value: i })) }).success).toBe(false);
    expect(ChartData.safeParse({ title: 'Title', items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }).success).toBe(true);
  });
});

describe('groundTranslatedChart (Georgian chart from the Translator)', () => {
  const en = chart([{ label: 'Fiscal 2027', value: 115 }, { label: 'Fiscal 2028', value: 230 }]);
  const ka = (items: { label: string; value: number }[], title = 'Broadcom-ის AI შემოსავლის პროგნოზი') => ChartData.parse({ title, unit: 'მლრდ $', items });

  it('accepts same items, same order, same values, same digits', () => {
    const k = ka([{ label: '2027 ფისკალური წელი', value: 115 }, { label: '2028 ფისკალური წელი', value: 230 }]);
    expect(groundTranslatedChart(en, k)).toEqual(k);
  });

  it('rejects a changed value, a different item count, or a changed year', () => {
    expect(groundTranslatedChart(en, ka([{ label: '2027', value: 116 }, { label: '2028', value: 230 }]))).toBeNull();
    expect(groundTranslatedChart(en, ka([{ label: '2027', value: 115 }, { label: '2028', value: 230 }, { label: 'x', value: 1 }]))).toBeNull();
    expect(groundTranslatedChart(en, ka([{ label: '2027', value: 115 }, { label: '2029', value: 230 }]))).toBeNull();
    expect(groundTranslatedChart(en, null)).toBeNull();
  });
});
