// Templates (PLAN 3.3): elements and attributes matched to the component and directive selectors in scope
// (ui.uses_component, ui.uses_directive), event bindings and expressions bound to component members (references),
// control flow blocks. Spans map to the `.html` file or into the inline template literal.
import type * as T from 'typescript';
import type { Extractor } from '../extract/core.ts';
import type { NG, Selected } from '../toolchain.ts';
import type { Span } from '../model.ts';
import { type AngularIndex, type DirectiveMeta, resolveRelative } from './components.ts';
import { prop, stringValue, unwrap } from './common.ts';
import { compareOrdinal } from '../util/canonical.ts';

/** Angular's own structural elements: never components, so never an unresolved component use. */
const BUILT_IN_ELEMENTS = new Set(['ng-container', 'ng-content', 'ng-template']);

interface Mapper {
  path: string;
  span(start: number, end: number): Span;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function htmlMapper(path: string, text: string): Mapper {
  const starts = lineStarts(text);
  const at = (o: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: o - starts[lo] + 1 };
  };
  return {
    path,
    span(start, end) {
      const a = at(start);
      const b = at(Math.max(start, end));
      return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
    },
  };
}

function inlineMapper(ex: Extractor, path: string, literal: T.Node): Mapper {
  const sf = literal.getSourceFile();
  const base = literal.getStart(sf) + 1; // after the opening quote
  return { path, span: (start, end) => ex.span(sf, base + start, base + Math.max(start, end)) };
}

export function observeTemplates(ex: Extractor, index: AngularIndex, ngSel: Selected<NG>): void {
  const ts = ex.ts;
  const ng = ngSel.module as any;
  for (const [rel, sf] of [...ex.files].sort(([a], [b]) => compareOrdinal(a, b))) {
    for (const s of sf.statements) {
      if (!ts.isClassDeclaration(s)) continue;
      const meta = index.meta(s);
      if (!meta || meta.kind !== 'component' || !meta.source) continue;
      let text: string | null = null;
      let mapper: Mapper | null = null;
      const templateUrl = stringValue(ex, prop(ex, meta.arg, 'templateUrl'));
      const inline = prop(ex, meta.arg, 'template');
      if (templateUrl) {
        const path = resolveRelative(rel, templateUrl);
        if (!ex.gen.hasBlob(path)) {
          ex.gen.diagnostic('warning', 'template-missing', path, 'partial', `Template '${path}' of ${meta.entity} is not in the repository.`);
          continue;
        }
        text = ex.fileText(path);
        mapper = htmlMapper(path, text);
      } else if (inline) {
        const u = unwrap(ex, inline);
        if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) {
          text = u.text;
          mapper = inlineMapper(ex, rel, u);
        } else {
          ex.gen.diagnostic('info', 'template-not-literal', rel, 'unsupported', `The inline template of ${meta.entity} is not a string literal; it is not analysed.`);
          continue;
        }
      }
      if (text === null || mapper === null) continue;
      walkTemplate(ex, index, ng, meta, text, mapper);
    }
  }
}

function walkTemplate(ex: Extractor, index: AngularIndex, ng: any, component: DirectiveMeta, text: string, mapper: Mapper): void {
  const parsed = ng.parseTemplate(text, mapper.path, { preserveWhitespaces: false, enableLetSyntax: true, enableBlockSyntax: true });
  if (parsed.errors && parsed.errors.length > 0) {
    ex.gen.diagnostic('warning', 'template-parse-error', mapper.path, 'partial', `${parsed.errors.length} template parse error(s) with @angular/compiler ${ng.VERSION.full}: ${String(parsed.errors[0].msg ?? parsed.errors[0]).split('\n')[0]}`);
  }
  const { scope, known } = index.templateScope(component);
  const matcher = new ng.SelectorMatcher();
  for (const d of scope.sort((a, b) => compareOrdinal(a.entity, b.entity))) {
    if (d.selector) {
      try {
        matcher.addSelectables(ng.CssSelector.parse(d.selector), d);
      } catch {
        // a selector the compiler cannot parse cannot match either
      }
    }
  }
  const pipes = new Map<string, DirectiveMeta>();
  for (const d of scope) if (d.kind === 'pipe' && d.pipeName) pipes.set(d.pipeName, d);
  const classType = ex.checker ? ex.checker.getTypeAtLocation(component.node) : null;
  const member = (name: string): string | null => {
    if (!classType) return null;
    const p = classType.getProperty(name);
    return p ? ex.entityOfSymbol(p) : null;
  };
  const evidence = (start: number, end: number) => ex.evidenceAt(mapper.path, mapper.span(start, end));

  const visitExpression = (root: unknown, locals: Set<string>) => {
    const seen = new Set<unknown>();
    const implicit = (r: unknown) => r instanceof ng.ImplicitReceiver;
    const ref = (name: string, usage: string, span: { start: number; end: number } | undefined) => {
      if (!span || locals.has(name)) return;
      const target = member(name);
      if (!target) return;
      ex.relation('references', component.entity, target, 'exact', [evidence(span.start, span.end)], { usage });
    };
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      if (ng.ASTWithSource && node instanceof ng.ASTWithSource) return walk(node.ast);
      const isCall = (ng.Call && node instanceof ng.Call) || (ng.SafeCall && node instanceof ng.SafeCall);
      if (isCall && (node.receiver instanceof ng.PropertyRead || (ng.SafePropertyRead && node.receiver instanceof ng.SafePropertyRead)) && implicit(node.receiver.receiver)) {
        seen.add(node.receiver);
        ref(node.receiver.name, 'invocation', node.receiver.nameSpan ?? node.receiver.sourceSpan);
        walk(node.args);
        return;
      }
      if ((node instanceof ng.PropertyRead || (ng.SafePropertyRead && node instanceof ng.SafePropertyRead)) && implicit(node.receiver)) {
        ref(node.name, 'read', node.nameSpan ?? node.sourceSpan);
        return;
      }
      if (ng.PropertyWrite && node instanceof ng.PropertyWrite && implicit(node.receiver)) {
        ref(node.name, 'write', node.nameSpan ?? node.sourceSpan);
        walk(node.value);
        return;
      }
      if (ng.Binary && node instanceof ng.Binary && /^(=|\+=|-=|\*=|\/=|%=|\*\*=|&&=|\|\|=|\?\?=)$/.test(node.operation) && node.left instanceof ng.PropertyRead && implicit(node.left.receiver)) {
        seen.add(node.left);
        ref(node.left.name, 'write', node.left.nameSpan ?? node.left.sourceSpan);
        walk(node.right);
        return;
      }
      if (ng.BindingPipe && node instanceof ng.BindingPipe) {
        const pipe = pipes.get(node.name);
        const span = node.nameSpan ?? node.sourceSpan;
        if (pipe && span) ex.relation('references', component.entity, pipe.entity, 'exact', [evidence(span.start, span.end)], { usage: 'other' });
      }
      for (const key of Object.keys(node)) {
        if (key === 'sourceSpan' || key === 'span' || key === 'nameSpan' || key === 'keySpan' || key === 'valueSpan' || key === 'handlerSpan') continue;
        const v = node[key];
        if (v && typeof v === 'object') walk(v);
      }
    };
    walk(root);
  };

  const selectorFor = (node: any, isTemplate: boolean) => {
    const cs = new ng.CssSelector();
    cs.setElement(isTemplate ? 'ng-template' : node.name);
    const attrs: [string, string][] = [];
    for (const a of node.attributes ?? []) attrs.push([a.name, a.value ?? '']);
    for (const i of node.inputs ?? []) if (i.type === 0 || i.type === 5 || i.type === undefined) attrs.push([i.name, '']);
    for (const o of node.outputs ?? []) attrs.push([o.name, '']);
    if (isTemplate) for (const t of node.templateAttrs ?? []) attrs.push([t.name, typeof t.value === 'string' ? t.value : '']);
    for (const [name, value] of attrs) {
      cs.addAttribute(name, value);
      if (name.toLowerCase() === 'class') for (const c of value.trim().split(/\s+/).filter(Boolean)) cs.addClassName(c);
    }
    return cs;
  };

  const match = (node: any, isTemplate: boolean): DirectiveMeta[] => {
    const out: DirectiveMeta[] = [];
    matcher.match(selectorFor(node, isTemplate), (_s: unknown, d: DirectiveMeta) => out.push(d));
    return [...new Map(out.map((d) => [d.entity, d])).values()].sort((a, b) => compareOrdinal(a.entity, b.entity));
  };

  const childrenOf = (n: any): any[] => [...(n.children ?? []), ...(n.branches ?? []), ...(n.groups ?? []), ...(n.cases ?? []), n.empty, n.placeholder, n.loading, n.error].filter(Boolean);

  const visitNodes = (nodes: any[], inherited: Set<string>) => {
    const locals = new Set(inherited);
    for (const n of nodes) if (ng.TmplAstLetDeclaration && n instanceof ng.TmplAstLetDeclaration) locals.add(n.name);
    for (const n of nodes) visitNode(n, locals);
  };

  const visitNode = (n: any, inherited: Set<string>) => {
    const locals = new Set(inherited);
    for (const r of n.references ?? []) locals.add(r.name);
    for (const v of n.variables ?? []) locals.add(v.name);
    if (n.item?.name) locals.add(n.item.name);
    const cv = n.contextVariables;
    if (Array.isArray(cv)) for (const v of cv) locals.add(v.name);
    else if (cv && typeof cv === 'object') for (const v of Object.values<any>(cv)) if (v?.name) locals.add(v.name);
    if (n.expressionAlias?.name) locals.add(n.expressionAlias.name);

    const isElement = n instanceof ng.TmplAstElement;
    const isTemplate = n instanceof ng.TmplAstTemplate;
    if (isElement || isTemplate) {
      const matched = match(n, isTemplate);
      const span = n.startSourceSpan ?? n.sourceSpan;
      const ev = () => evidence(span.start.offset, span.end.offset);
      let component = false;
      for (const d of matched) {
        if (d.kind === 'component' && isElement) {
          component = true;
          ex.observe('ui.uses_component', { from: componentEntity, selector: n.name, to: d.entity }, [ev()]);
        } else if (d.kind === 'directive' || (d.kind === 'component' && isTemplate)) {
          ex.observe('ui.uses_directive', { from: componentEntity, selector: d.selector, to: d.entity }, [ev()]);
        }
      }
      if (isElement && !component && matched.length === 0 && n.name.includes('-') && !n.name.startsWith(':') && !BUILT_IN_ELEMENTS.has(n.name)) {
        ex.observe('ui.uses_component', { from: componentEntity, selector: n.name, to: 'unresolved', reason: known ? 'no component in the template scope matches this element' : 'the template scope is unknown (no declaring NgModule found)' }, [ev()]);
      }
      for (const i of n.inputs ?? []) visitExpression(i.value, locals);
      for (const o of n.outputs ?? []) visitExpression(o.handler, locals);
      if (isTemplate) for (const t of n.templateAttrs ?? []) if (t.value && typeof t.value === 'object') visitExpression(t.value, locals);
    } else {
      for (const key of ['value', 'expression', 'trackBy', 'condition']) {
        const v = n[key];
        if (v && typeof v === 'object') visitExpression(v, locals);
      }
    }
    visitNodes(childrenOf(n), locals);
  };

  const componentEntity = component.entity;
  visitNodes(parsed.nodes ?? [], new Set());
}
