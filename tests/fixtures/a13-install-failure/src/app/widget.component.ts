import { Component } from '@angular/core';
import { Base } from './base';

@Component({
  selector: 'app-widget',
  template: '<p>{{ render() }}</p>',
})
export class WidgetComponent extends Base {
  render(): string {
    return 'widget';
  }
}
