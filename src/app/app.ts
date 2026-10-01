import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { Game } from './game/game';
import { Intro } from './game/intro';

@Component({
  selector: 'app-root',
  imports: [Game, Intro],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly playing = signal(false);
}
