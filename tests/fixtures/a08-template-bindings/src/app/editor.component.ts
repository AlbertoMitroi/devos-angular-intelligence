import { Component, computed, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';

@Component({
  selector: 'app-editor',
  imports: [CurrencyPipe],
  templateUrl: './editor.component.html',
})
export class EditorComponent {
  name = '';
  total = 0;
  mode = signal<'view' | 'edit'>('view');
  canSave = computed(() => this.name.length > 0);

  save(): void {
    this.total = this.total + 1;
  }

  reset(): void {
    this.name = '';
  }
}
