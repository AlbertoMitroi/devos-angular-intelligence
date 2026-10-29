const dir = process.argv[2];
const { createRequire } = await import('node:module');
const req = createRequire(dir + '/package.json');
const path = req.resolve('@angular/compiler');
const ng = await import(path);
const tpl = `<app-header [title]="title()" (save)="onSave($event)"></app-header>
@if (items().length > 0) {
  @for (item of items(); track item.id) { <app-item [item]="item" (click)="select(item)"/> }
  @empty { <p>none</p> }
} @else { <app-empty/> }
@defer (on viewport) { <app-heavy/> } @placeholder { <span>...</span> }
<div *ngIf="x"><app-legacy></app-legacy></div>`;
const r = ng.parseTemplate(tpl, 'inline.html', { preserveWhitespaces: false });
const out = [];
function walk(nodes, depth) {
  for (const n of nodes) {
    const kind = n.constructor.name;
    const name = n.name ?? n.tagName ?? '';
    const span = n.sourceSpan ? `${n.sourceSpan.start.line + 1}:${n.sourceSpan.start.col + 1}` : '';
    const extra = [];
    for (const i of n.inputs ?? []) extra.push(`[${i.name}]`);
    for (const o of n.outputs ?? []) extra.push(`(${o.name})=${o.handler?.ast?.constructor?.name}`);
    out.push(`${' '.repeat(depth)}${kind} ${name} ${span} ${extra.join(' ')}`);
    const kids = [n.children, n.branches, n.cases, n.empty ? [n.empty] : null, n.placeholder ? [n.placeholder] : null, n.loading ? [n.loading]: null, n.error ? [n.error]:null, n.templateAttrs ? [] : null].filter(Boolean).flat();
    walk(kids, depth + 2);
  }
}
walk(r.nodes, 0);
console.log('version', ng.VERSION.full, 'errors', (r.errors ?? []).length);
console.log(out.join('\n'));
