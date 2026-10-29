import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { SharedModule } from './shared/shared.module';
import { AppComponent } from './app.component';
import { ListComponent } from './list.component';

@NgModule({
  declarations: [AppComponent, ListComponent],
  imports: [BrowserModule, SharedModule],
  bootstrap: [AppComponent],
})
export class AppModule {}
