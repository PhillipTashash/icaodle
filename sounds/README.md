# Sounds

Drop your audio files in this folder with **exactly these names** and a `.wav` (or `.mp3`) extension. Any file that's missing falls back to the built-in synthesized beeps, so you can add them one at a time. Reload the page after adding a file (Ctrl+Shift+R).

| File name | When it plays | Suggested feel |
|---|---|---|
| `correct.wav` | You solve a round | Happy, short (about 1 second): a bright chime or small fanfare |
| `wrong.wav` | A wrong guess | "Bum-bump": two quick descending notes (about 0.5 s) |
| `skip.wav` | You press Skip (not on the last guess). Optional; if missing, `wrong` is used | Softer than `wrong`, like a "whoosh" or a single low note |
| `lost.wav` | You lose a round (4th wrong guess, or Skip on the last guess) | Worse "bum-bump-bummm": three slow descending low notes (about 1.5 s) |
| `flap.wav` | **Every flap flip** on the split-flap display (the answer spinning in). Optional; a synthesized click is used if missing | A very short mechanical "clack" or "tick", 30 to 80 ms. It fires about 25 times per letter, so keep it tiny and soft |
| `finish.wav` | You finish all 5 rounds (the score screen appears). Optional; silent if missing | Celebration, boarding-chime style (about 2 s) |

Tips: keep each file under 2 seconds and 200 KB. Normalize the volume so they all sound about equally loud.
