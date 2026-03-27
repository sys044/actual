import { renderHook, waitFor } from '@testing-library/react';
import { HyperFormula } from 'hyperformula';
import enUS from 'hyperformula/i18n/languages/enUS';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as connection from 'loot-core/platform/client/connection';

import {
  evaluateFormulaExpression,
  findCustomFunctionCalls,
  splitTopLevelArgs,
} from '../components/formula/formulaPreProcessor';
import { TestProviders } from '../mocks';
import {
  parseBudgetParam,
  resolveBudgetParam,
  useFormulaExecution,
} from './useFormulaExecution';

// HyperFormula requires the language pack to be registered once globally
// before any instance can be constructed with language: 'enUS'.
beforeAll(() => {
  try {
    HyperFormula.registerLanguage('enUS', enUS);
  } catch (_) {
    // Already registered — safe to continue
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EN_US = 'en-US';

// ---------------------------------------------------------------------------
// Unit tests: splitTopLevelArgs
// ---------------------------------------------------------------------------

describe('splitTopLevelArgs', () => {
  it('splits simple flat args', () => {
    expect(splitTopLevelArgs('"a", "b", "c"')).toEqual(['"a"', '"b"', '"c"']);
  });

  it('preserves nested parentheses as a single arg', () => {
    expect(
      splitTopLevelArgs('TEXT(EDATE(TODAY(), 1), "yyyy-mm"), "foo"'),
    ).toEqual(['TEXT(EDATE(TODAY(), 1), "yyyy-mm")', '"foo"']);
  });

  it('preserves nested braces as a single arg', () => {
    expect(splitTopLevelArgs('{"id1";"id2"}, "2026-01"')).toEqual([
      '{"id1";"id2"}',
      '"2026-01"',
    ]);
  });

  it('handles a quoted string containing a comma', () => {
    expect(splitTopLevelArgs('"hello, world", 42')).toEqual([
      '"hello, world"',
      '42',
    ]);
  });

  it('trims whitespace from each arg', () => {
    expect(splitTopLevelArgs('  "a"  ,  "b"  ')).toEqual(['"a"', '"b"']);
  });

  it('returns single-element array when no commas at top level', () => {
    expect(splitTopLevelArgs('TEXT(EDATE(TODAY(), 1), "yyyy-mm")')).toEqual([
      'TEXT(EDATE(TODAY(), 1), "yyyy-mm")',
    ]);
  });

  it('ignores a trailing comma produced by a formatter', () => {
    // e.g. "BUDGET_QUERY(\n  ...,\n  ...,\n)" produces trailing comma
    expect(splitTopLevelArgs('"a", "b", ')).toEqual(['"a"', '"b"']);
  });

  it('returns empty array for empty string', () => {
    expect(splitTopLevelArgs('')).toEqual([]);
  });

  it('handles single-quoted strings', () => {
    expect(splitTopLevelArgs("'hello, world', 'foo'")).toEqual([
      "'hello, world'",
      "'foo'",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: findCustomFunctionCalls
// ---------------------------------------------------------------------------

describe('findCustomFunctionCalls', () => {
  it('finds a simple call with string args', () => {
    const result = findCustomFunctionCalls(
      '=BUDGET_QUERY("budgeted", "2026-01", "2026-03")',
      'BUDGET_QUERY',
    );
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual(['"budgeted"', '"2026-01"', '"2026-03"']);
    expect(result[0].fullMatch).toBe(
      'BUDGET_QUERY("budgeted", "2026-01", "2026-03")',
    );
  });

  it('finds a call where an arg contains nested parens', () => {
    const formula =
      '=BUDGET_QUERY("balance_end", QUERY_EXTRACT_CATEGORIES("q"), QUERY_EXTRACT_TIMEFRAME_START("q"), TEXT(EDATE(TODAY(), 1), "yyyy-mm"))';
    const result = findCustomFunctionCalls(formula, 'BUDGET_QUERY');
    expect(result).toHaveLength(1);
    expect(result[0].args).toHaveLength(4);
    expect(result[0].args[3]).toBe('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
  });

  it('finds multiple distinct call sites', () => {
    const formula =
      '=BUDGET_QUERY("budgeted", "a", "b", "c") + BUDGET_QUERY("spent", "a", "b", "c")';
    const result = findCustomFunctionCalls(formula, 'BUDGET_QUERY');
    expect(result).toHaveLength(2);
    expect(result[0].args[0]).toBe('"budgeted"');
    expect(result[1].args[0]).toBe('"spent"');
  });

  it('returns empty array when function is not present', () => {
    expect(findCustomFunctionCalls('=1+2', 'BUDGET_QUERY')).toEqual([]);
  });

  it('is case-insensitive for the function name', () => {
    const result = findCustomFunctionCalls(
      '=budget_query("a","b","c","d")',
      'BUDGET_QUERY',
    );
    expect(result).toHaveLength(1);
  });

  it('handles QUERY() calls with a simple string arg', () => {
    const result = findCustomFunctionCalls('=QUERY("myQuery") + 1', 'QUERY');
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual(['"myQuery"']);
    expect(result[0].fullMatch).toBe('QUERY("myQuery")');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseBudgetParam
// ---------------------------------------------------------------------------

describe('parseBudgetParam', () => {
  it('parses a QUERY_EXTRACT_* extraction function', () => {
    const result = parseBudgetParam('QUERY_EXTRACT_CATEGORIES("onBudget")');
    expect(result).toEqual({
      type: 'extraction',
      data: { funcName: 'QUERY_EXTRACT_CATEGORIES', queryName: 'onBudget' },
    });
  });

  it('parses a QUERY_EXTRACT_TIMEFRAME_START extraction function', () => {
    const result = parseBudgetParam('QUERY_EXTRACT_TIMEFRAME_START("myQ")');
    expect(result).toEqual({
      type: 'extraction',
      data: { funcName: 'QUERY_EXTRACT_TIMEFRAME_START', queryName: 'myQ' },
    });
  });

  it('parses an HF array literal', () => {
    const result = parseBudgetParam('{"id1";"id2";"id3"}');
    expect(result).toEqual({ type: 'literal', data: ['id1', 'id2', 'id3'] });
  });

  it('parses a double-quoted string literal', () => {
    const result = parseBudgetParam('"2026-03"');
    expect(result).toEqual({ type: 'literal', data: '2026-03' });
  });

  it('parses a single-quoted string literal', () => {
    const result = parseBudgetParam("'2026-03'");
    expect(result).toEqual({ type: 'literal', data: '2026-03' });
  });

  it('falls back to formula type for arbitrary expressions', () => {
    const result = parseBudgetParam('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
    expect(result).toEqual({
      type: 'formula',
      data: 'TEXT(EDATE(TODAY(), 1), "yyyy-mm")',
    });
  });

  it('returns null for empty param', () => {
    expect(parseBudgetParam('')).toBeNull();
    expect(parseBudgetParam('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: evaluateFormulaExpression
// ---------------------------------------------------------------------------

describe('evaluateFormulaExpression', () => {
  it('evaluates a simple arithmetic expression', () => {
    expect(evaluateFormulaExpression('1+2', EN_US)).toBe(3);
  });

  it('evaluates TEXT(DATE(...), format) to a formatted string', () => {
    // DATE(2026, 4, 1) → April 2026. EDATE(..., 0) keeps the same month.
    const result = evaluateFormulaExpression(
      'TEXT(DATE(2026, 4, 1), "yyyy-mm")',
      EN_US,
    );
    expect(result).toBe('2026-04');
  });

  it('evaluates EDATE(DATE(...), n) correctly', () => {
    // Move forward 1 month from 2026-03-01 → 2026-04-01
    const result = evaluateFormulaExpression(
      'TEXT(EDATE(DATE(2026, 3, 1), 1), "yyyy-mm")',
      EN_US,
    );
    expect(result).toBe('2026-04');
  });

  it('returns null for a HyperFormula error', () => {
    // UNKNOWN_FUNC() → NAME error in HF
    expect(evaluateFormulaExpression('UNKNOWN_FUNC()', EN_US)).toBeNull();
  });

  it('resolves a named expression passed in', () => {
    const result = evaluateFormulaExpression('MY_VAL + 10', EN_US, {
      MY_VAL: 5,
    });
    expect(result).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: resolveBudgetParam
// ---------------------------------------------------------------------------

describe('resolveBudgetParam', () => {
  const extractionResults: Record<string, Record<string, unknown>> = {
    QUERY_EXTRACT_CATEGORIES: {
      'QUERY_EXTRACT_CATEGORIES(myQ)': ['cat1', 'cat2'],
    },
    QUERY_EXTRACT_TIMEFRAME_START: {
      'QUERY_EXTRACT_TIMEFRAME_START(myQ)': '2026-01',
    },
    QUERY_EXTRACT_TIMEFRAME_END: {
      'QUERY_EXTRACT_TIMEFRAME_END(myQ)': '2026-03',
    },
  };

  it('resolves an extraction param from extractionResults', () => {
    const parsed = parseBudgetParam('QUERY_EXTRACT_CATEGORIES("myQ")');
    expect(resolveBudgetParam(parsed, extractionResults, EN_US)).toEqual([
      'cat1',
      'cat2',
    ]);
  });

  it('resolves a literal string param directly', () => {
    const parsed = parseBudgetParam('"2026-01"');
    expect(resolveBudgetParam(parsed, extractionResults, EN_US)).toBe(
      '2026-01',
    );
  });

  it('resolves a literal array param directly', () => {
    const parsed = parseBudgetParam('{"id1";"id2"}');
    expect(resolveBudgetParam(parsed, extractionResults, EN_US)).toEqual([
      'id1',
      'id2',
    ]);
  });

  it('resolves a formula expression param via HyperFormula', () => {
    const parsed = parseBudgetParam('TEXT(DATE(2026, 4, 1), "yyyy-mm")');
    expect(resolveBudgetParam(parsed, extractionResults, EN_US)).toBe(
      '2026-04',
    );
  });

  it('returns undefined for null parsed param', () => {
    expect(resolveBudgetParam(null, extractionResults, EN_US)).toBeUndefined();
  });

  it('passes namedExpressions through to evaluateFormulaExpression', () => {
    const parsed = parseBudgetParam('TEXT(DATE(MY_YEAR, 3, 1), "yyyy-mm")');
    expect(
      resolveBudgetParam(parsed, extractionResults, EN_US, { MY_YEAR: 2027 }),
    ).toBe('2027-03');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: executeFormula pipeline (via the exported pure functions
// plus mocked send for the React hook side-effects)
// ---------------------------------------------------------------------------

// We test the hook's async execution path by calling the exported utility
// functions directly and simulating the full pipeline for the key scenarios.
// Full hook (useEffect) integration is covered by E2E tests.

describe('BUDGET_QUERY with formula-expression end date (regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin time to 2026-03-27 so TODAY() is deterministic
    vi.setSystemTime(new Date('2026-03-27T12:00:00Z'));

    vi.spyOn(connection, 'send').mockImplementation(
      async (name: string, args?: unknown) => {
        switch (name) {
          case 'make-filters-from-conditions':
            return { filters: [] };
          case 'get-categories':
            return {
              list: [
                { id: 'cat1', name: 'Food', is_income: false, hidden: false },
                {
                  id: 'cat2',
                  name: 'Transport',
                  is_income: false,
                  hidden: false,
                },
              ],
              grouped: [],
            };
          case 'envelope-budget-month':
            return [
              { name: 'budget/budget-cat1', value: 50000 },
              { name: 'budget/budget-cat2', value: 30000 },
              { name: 'budget/sum-amount-cat1', value: -20000 },
              { name: 'budget/sum-amount-cat2', value: -10000 },
              { name: 'budget/leftover-cat1', value: 30000 },
              { name: 'budget/leftover-cat2', value: 20000 },
              { name: 'budget/carryover-cat1', value: 0 },
              { name: 'budget/carryover-cat2', value: 0 },
            ];
          case 'query':
            return { data: 0 };
          case 'get-earliest-transaction':
            return { date: '2026-01-01' };
          case 'get-latest-transaction':
            return { date: '2026-03-27' };
          default:
            throw new Error(`Unexpected send call: ${name}`);
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parseBudgetParam correctly identifies TEXT(EDATE(TODAY(),...)) as formula type', () => {
    const parsed = parseBudgetParam('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
    expect(parsed?.type).toBe('formula');
    expect(parsed?.data).toBe('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
  });

  it('resolves TEXT(EDATE(TODAY(), 1)) to next calendar month', () => {
    // With system time pinned to 2026-03-27, TODAY() = 2026-03-27
    // EDATE(TODAY(), 1) adds 1 month → 2026-04-27
    // TEXT(..., "yyyy-mm") → "2026-04"
    const parsed = parseBudgetParam('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
    const result = resolveBudgetParam(parsed, {}, EN_US);
    expect(result).toBe('2026-04');
  });

  it('findCustomFunctionCalls finds BUDGET_QUERY with nested formula arg', () => {
    const formula = [
      '=BUDGET_QUERY(',
      '    "balance_end",',
      '    QUERY_EXTRACT_CATEGORIES("onBudget"),',
      '    QUERY_EXTRACT_TIMEFRAME_START("onBudget"),',
      '    TEXT(EDATE(TODAY(), 1), "yyyy-mm")',
      ')',
    ].join('\n');

    const calls = findCustomFunctionCalls(formula, 'BUDGET_QUERY');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toHaveLength(4);
    expect(calls[0].args[0].trim()).toBe('"balance_end"');
    expect(calls[0].args[3].trim()).toBe('TEXT(EDATE(TODAY(), 1), "yyyy-mm")');
  });
});

describe('findCustomFunctionCalls: QUERY and QUERY_COUNT extraction', () => {
  it('extracts QUERY calls with string args', () => {
    const formula = '=QUERY("myQuery") + QUERY("otherQuery")';
    const calls = findCustomFunctionCalls(formula, 'QUERY');
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0]).toBe('"myQuery"');
    expect(calls[1].args[0]).toBe('"otherQuery"');
  });

  it('does not confuse QUERY_COUNT with QUERY', () => {
    const formula = '=QUERY_COUNT("foo") + QUERY("bar")';
    const queryCalls = findCustomFunctionCalls(formula, 'QUERY');
    const countCalls = findCustomFunctionCalls(formula, 'QUERY_COUNT');

    // QUERY("bar") only (QUERY_COUNT is a different function name)
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].args[0]).toBe('"bar"');

    expect(countCalls).toHaveLength(1);
    expect(countCalls[0].args[0]).toBe('"foo"');
  });
});

describe('evaluateFormulaExpression: edge cases', () => {
  it('handles a pure numeric expression', () => {
    expect(evaluateFormulaExpression('100 * 0.1', EN_US)).toBeCloseTo(10);
  });

  it('handles date arithmetic without TEXT wrapper', () => {
    // EDATE(DATE(2026,3,1), 1) returns a date serial number in HF, not a string
    const result = evaluateFormulaExpression(
      'EDATE(DATE(2026, 3, 1), 1)',
      EN_US,
    );
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('returns null for division by zero', () => {
    // HF returns DIV0 error object → null
    expect(evaluateFormulaExpression('1/0', EN_US)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: QUERY and QUERY_COUNT through the hook
//
// fetchQuerySum converts the raw integer via integerToAmount(n, 2) → ÷100.
// fetchQueryCount returns the raw integer unchanged.
// Both go through buildFilteredTransactionsQuery which calls
// send('make-filters-from-conditions', ...) then send('query', ...).
// ---------------------------------------------------------------------------

// Raw integer returned by the mocked backend for these tests.
// integerToAmount(MOCK_INT, 2) === MOCK_AMOUNT
const MOCK_INT = 5000;
const MOCK_AMOUNT = 50; // 5000 ÷ 100

function installSendMock() {
  return vi
    .spyOn(connection, 'send')
    .mockImplementation(async (name: string) => {
      switch (name) {
        case 'make-filters-from-conditions':
          return { filters: [] };
        case 'query':
          return { data: MOCK_INT };
        default:
          throw new Error(
            `Unexpected send call in test: ${JSON.stringify(name)}`,
          );
      }
    });
}

const hookOptions = { wrapper: TestProviders };

describe('QUERY function (hook integration)', () => {
  // Stable queries object — same reference across renders avoids extra effect runs
  const queries = { expenses: {}, income: {} };

  beforeEach(() => { installSendMock(); });
  afterEach(() => vi.restoreAllMocks());

  it('resolves QUERY("name") to the amount-converted sum', async () => {
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY("expenses")', queries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    // MOCK_INT (5000) ÷ 100 = MOCK_AMOUNT (50)
    expect(result.current.result).toBe(MOCK_AMOUNT);
  });

  it('returns 0 for an unknown query name', async () => {
    const emptyQueries = {};
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY("unknown")', emptyQueries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBe(0);
  });

  it('sums two different QUERY calls', async () => {
    // Each query returns MOCK_AMOUNT → total = MOCK_AMOUNT * 2
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY("income") + QUERY("expenses")', queries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.result).toBe(MOCK_AMOUNT * 2);
  });

  it('deduplicates the same query name and fetches only once', async () => {
    const spy = vi.mocked(connection.send);
    const { result } = renderHook(
      () =>
        useFormulaExecution(
          '=QUERY("expenses") + QUERY("expenses")',
          queries,
        ),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Both occurrences resolve to MOCK_AMOUNT → 50 + 50 = 100
    expect(result.current.result).toBe(MOCK_AMOUNT * 2);
    // Only one 'query' message sent — the name was deduplicated before fetching
    const querySendCount = spy.mock.calls.filter(([n]) => n === 'query').length;
    expect(querySendCount).toBe(1);
  });

  it('allows arithmetic on a QUERY result', async () => {
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY("expenses") * 0.1', queries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // 50 * 0.1 = 5
    expect(result.current.result).toBeCloseTo(MOCK_AMOUNT * 0.1);
  });
});

describe('QUERY_COUNT function (hook integration)', () => {
  // Stable queries object — same reference across renders avoids extra effect runs
  const queries = { expenses: {} };

  beforeEach(() => { installSendMock(); });
  afterEach(() => vi.restoreAllMocks());

  it('resolves QUERY_COUNT("name") to the raw integer count (not ÷100)', async () => {
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY_COUNT("expenses")', queries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    // Count is NOT amount-converted — MOCK_INT returned as-is
    expect(result.current.result).toBe(MOCK_INT);
  });

  it('returns 0 for an unknown query name', async () => {
    const emptyQueries = {};
    const { result } = renderHook(
      () => useFormulaExecution('=QUERY_COUNT("unknown")', emptyQueries),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBe(0);
  });

  it('combines QUERY and QUERY_COUNT in the same formula', async () => {
    // QUERY("expenses") → integerToAmount(MOCK_INT, 2) = MOCK_AMOUNT = 50
    // QUERY_COUNT("expenses") → MOCK_INT raw = 5000
    // 50 + 5000 = 5050
    const { result } = renderHook(
      () =>
        useFormulaExecution(
          '=QUERY("expenses") + QUERY_COUNT("expenses")',
          queries,
        ),
      hookOptions,
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.result).toBe(MOCK_AMOUNT + MOCK_INT);
  });
});
