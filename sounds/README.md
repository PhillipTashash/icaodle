# Sounds

Drop your audio files in this folder with **exactly these names** and a `.wav` (or `.mp3`) extension. Any file that's missing falls back to the built-in synthesized beeps, so you can add them one at a time. Reload the page after adding a file (Ctrl+Shift+R).

| File name | When it plays | Suggested feel |
|---|---|---|
| `streak1.wav` | You solve a round that is not part of a streak | Happy, short (about 1 second): a bright chime |
| `streak2.wav` to `streak4.wav` | You solve 2, 3 or 4 rounds in a row | Each a bit bigger than the one before |
| `streak5.wav` | You solve all 5 in a row (it is also the end-of-game sound) | The big one |
| `end_game.wav` | The game ends and the last round was not a 5-in-a-row | A short sign-off |
| `correct.wav` | Not used by the game any more (`streak1.wav` replaced it) | |
| `wrong.wav` | A wrong guess | "Bum-bump": two quick descending notes (about 0.5 s) |
| `skip.wav` | You press Skip (not on the last guess). Optional; if missing, `wrong` is used | Softer than `wrong`, like a "whoosh" or a single low note |
| `lost.wav` | You lose a round (4th wrong guess, or Skip on the last guess) | Worse "bum-bump-bummm": three slow descending low notes (about 1.5 s) |
| `flap.wav` | **Every flap flip** on the split-flap display (the answer spinning in). Optional; a synthesized click is used if missing | A very short mechanical "clack" or "tick", 30 to 80 ms. It fires about 25 times per letter, so keep it tiny and soft |

Tips: keep each file short and small (16-bit, 48 kHz is plenty: 96 kHz / 24-bit files are four times the size for no audible gain). Normalize the volume so they all sound about equally loud.
