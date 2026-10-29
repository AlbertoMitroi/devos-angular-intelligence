import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-list',
  templateUrl: './list.component.html',
})
export class ListComponent {
  @Input() items: string[] = [];

  isLast(i: number): boolean {
    return i === this.items.length - 1;
  }
}
