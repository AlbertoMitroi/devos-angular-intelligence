import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BadgeComponent } from './badge.component';
import { HighlightDirective } from './highlight.directive';

@NgModule({
  declarations: [BadgeComponent, HighlightDirective],
  imports: [CommonModule],
  exports: [BadgeComponent, HighlightDirective, CommonModule],
})
export class SharedModule {}
