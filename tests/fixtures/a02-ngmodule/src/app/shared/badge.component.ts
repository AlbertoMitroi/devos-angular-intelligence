import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-badge',
  template: '<span class="badge">{{ label }}</span>',
})
export class BadgeComponent {
  @Input() label = '';
}
