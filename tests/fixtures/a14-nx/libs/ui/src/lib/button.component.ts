import { Component, input } from '@angular/core';

@Component({ selector: 'acme-button', template: '<button>{{ label() }}</button>' })
export class ButtonComponent {
  label = input('');
}
