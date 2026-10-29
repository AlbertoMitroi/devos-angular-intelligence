import { Component, signal } from '@angular/core';
import { HeaderComponent } from './header.component';
import { ItemComponent } from './item.component';

@Component({
  selector: 'app-root',
  imports: [HeaderComponent, ItemComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  title = signal('Shop');
  items = signal<{ id: number; name: string }[]>([]);
  selected: number | null = null;

  select(id: number): void {
    this.selected = id;
  }
}
