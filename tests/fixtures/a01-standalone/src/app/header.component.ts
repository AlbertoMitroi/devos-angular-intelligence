import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-header',
  template: `<h1>{{ title() }}</h1>
<button (click)="refresh.emit()">Refresh</button>`,
})
export class HeaderComponent {
  title = input('');
  refresh = output<void>();
}
