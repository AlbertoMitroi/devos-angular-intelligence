import { Component } from '@angular/core';

@Component({ selector: 'app-café', template: '<p>{{ greet() }}</p>' })
export class CaféComponent {
  emoji = '😀😀';	greet(): string {
    return this.emoji + 'ü';
  }
}
