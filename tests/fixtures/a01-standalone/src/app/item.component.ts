import { Component, input } from '@angular/core';

@Component({
  selector: 'app-item',
  template: '<span>{{ name() }}</span>',
})
export class ItemComponent {
  name = input.required<string>();
}
