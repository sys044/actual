/**
 * formulaPreProcessor.ts
 *
 * General-purpose utilities for pre-processing formula strings before they are
 * handed to HyperFormula. The pipeline pattern:
 *
 *   1. Scan the raw formula string for known custom function names.
 *   2. Split their argument lists with balanced-paren awareness so nested
 *      expressions (e.g. TEXT(EDATE(TODAY(), 1), "yyyy-mm")) are preserved
 *      as single arg tokens.
 *   3. Resolve each arg (may involve async server calls or a synchronous
 *      first-pass HyperFormula evaluation).
 *   4. Replace the original call site with the resolved scalar value.
 *   5. Hand the fully pre-processed formula string to HyperFormula.
 *
 * Adding a new custom function is as simple as providing a `CustomFunctionDef`:
 *
 *   const myDef: CustomFunctionDef<MyContext> = {
 *     name: 'MY_FUNC',
 *     async resolve(args, ctx) {
 *       return await fetchSomething(args[0], ctx);
 *     },
 *   };
 *   const result = await processCustomFunctions(formula, [myDef], ctx);
 */

import { HyperFormula } from 'hyperformula';

// ---------------------------------------------------------------------------
// splitTopLevelArgs
// ---------------------------------------------------------------------------

/**
 * Split the inner text of a function call's argument list on top-level commas,
 * respecting nested parentheses, braces, and quoted strings.
 *
 * @example
 * splitTopLevelArgs('TEXT(EDATE(TODAY(), 1), "yyyy-mm"), "foo"')
 * // → ['TEXT(EDATE(TODAY(), 1), "yyyy-mm")', '"foo"']
 */
export function splitTopLevelArgs(innerText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';

  for (let i = 0; i < innerText.length; i++) {
    const ch = innerText[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble && (ch === '(' || ch === '{')) {
      depth++;
      current += ch;
    } else if (!inSingle && !inDouble && (ch === ')' || ch === '}')) {
      depth--;
      current += ch;
    } else if (!inSingle && !inDouble && depth === 0 && ch === ',') {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim().length > 0) {
    args.push(current.trim());
  }

  return args;
}

// ---------------------------------------------------------------------------
// findCustomFunctionCalls
// ---------------------------------------------------------------------------

export type CustomFunctionCall = {
  /** The full matched substring, e.g. `BUDGET_QUERY("a", "b", "c", "d")` */
  fullMatch: string;
  /** Arguments already split at the top level */
  args: string[];
};

/**
 * Find all top-level calls to `funcName` in `formula` using balanced-paren
 * tracking, so arguments can themselves contain nested function calls.
 */
export function findCustomFunctionCalls(
  formula: string,
  funcName: string,
): CustomFunctionCall[] {
  const results: CustomFunctionCall[] = [];
  const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRegex = new RegExp(`${escaped}\\s*\\(`, 'gi');
  let nameMatch: RegExpExecArray | null;

  while ((nameMatch = nameRegex.exec(formula)) !== null) {
    const openParenIdx = formula.indexOf('(', nameMatch.index);
    let depth = 0;
    let closeParenIdx = -1;

    for (let i = openParenIdx; i < formula.length; i++) {
      const ch = formula[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          closeParenIdx = i;
          break;
        }
      }
    }

    if (closeParenIdx === -1) continue; // unbalanced — skip

    const fullMatch = formula.slice(nameMatch.index, closeParenIdx + 1);
    const innerText = formula.slice(openParenIdx + 1, closeParenIdx);
    const args = splitTopLevelArgs(innerText);
    results.push({ fullMatch, args });

    nameRegex.lastIndex = closeParenIdx + 1;
  }

  return results;
}

// ---------------------------------------------------------------------------
// evaluateFormulaExpression
// ---------------------------------------------------------------------------

/**
 * Evaluate a HyperFormula expression string (without the leading `=`) using a
 * throw-away HF instance. The same `locale` and `namedExpressions` used by the
 * main formula pass are forwarded so formatting functions (TEXT, etc.) behave
 * identically.
 *
 * This is the mechanism for resolving formula-expression arguments inside
 * custom functions (e.g. `TEXT(EDATE(TODAY(), 1), "yyyy-mm")`) before the async
 * business-logic phase runs — breaking the chicken-and-egg dependency.
 *
 * Returns `null` if HyperFormula produces an error cell value.
 */
export function evaluateFormulaExpression(
  expr: string,
  locale: string,
  namedExpressions?: Record<string, number | string>,
): string | number | null {
  let hf: ReturnType<typeof HyperFormula.buildEmpty> | null = null;
  try {
    hf = HyperFormula.buildEmpty({
      licenseKey: 'gpl-v3',
      localeLang: locale,
      language: 'enUS',
    });

    if (namedExpressions) {
      for (const [name, value] of Object.entries(namedExpressions)) {
        hf.addNamedExpression(
          name,
          typeof value === 'number' ? value : String(value),
        );
      }
    }

    const sheetName = hf.addSheet('Eval');
    const sheetId = hf.getSheetId(sheetName);
    if (sheetId === undefined) return null;

    hf.setCellContents({ sheet: sheetId, col: 0, row: 0 }, [[`=${expr}`]]);
    const cellValue = hf.getCellValue({ sheet: sheetId, col: 0, row: 0 });

    if (cellValue && typeof cellValue === 'object' && 'type' in cellValue) {
      return null; // HF error object
    }
    return cellValue as string | number | null;
  } finally {
    try {
      hf?.destroy();
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// CustomFunctionDef + processCustomFunctions
// ---------------------------------------------------------------------------

/**
 * Describes a custom function that should be pre-processed out of a formula
 * string before HyperFormula evaluates it.
 *
 * @template TContext - Arbitrary context object passed to `resolve` — use this
 * to carry async data sources, locale, namedExpressions, query configs, etc.
 *
 * @example
 * const queryDef: CustomFunctionDef<{ queries: QueriesMap }> = {
 *   name: 'QUERY',
 *   async resolve([nameArg], ctx) {
 *     const queryName = nameArg.replace(/^["']|["']$/g, '');
 *     return await fetchQuerySum(ctx.queries[queryName]);
 *   },
 * };
 */
export type CustomFunctionDef<TContext> = {
  /** Function name as it appears in the formula (case-insensitive match) */
  name: string;
  /**
   * Resolve a single call site to a scalar value that will replace it in the
   * formula string. Receives the already-split argument tokens and the context.
   *
   * Return a number or string. Returning `null` leaves the original call in
   * place (it will then be seen by HyperFormula, likely producing a NAME error).
   */
  resolve(
    args: string[],
    context: TContext,
  ): Promise<number | string | null> | number | string | null;
};

/**
 * Process all registered custom function definitions against `formula`,
 * sequentially replacing each call site with its resolved scalar value.
 *
 * Definitions are processed in the order they appear in `defs`, which matters
 * when one custom function's args contain calls to another custom function
 * (process inner functions first by placing them earlier in the array).
 *
 * @returns The formula string with all custom function calls replaced by their
 * resolved values, ready to be passed to HyperFormula.
 */
export async function processCustomFunctions<TContext>(
  formula: string,
  defs: CustomFunctionDef<TContext>[],
  context: TContext,
): Promise<string> {
  let processed = formula;

  for (const def of defs) {
    const calls = findCustomFunctionCalls(processed, def.name);

    for (const call of calls) {
      const resolved = await def.resolve(call.args, context);
      if (resolved !== null && resolved !== undefined) {
        processed = processed.replace(call.fullMatch, String(resolved));
      }
    }
  }

  return processed;
}
