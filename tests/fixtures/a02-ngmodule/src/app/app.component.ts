import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: '<app-list [items]="names"></app-list>',
})
export class AppComponent {
  names = ['a', 'b'];
}
