# Tinge

**Colour black-and-white photos, entirely on your own computer.**

Tinge is a desktop app for Windows and macOS. Drop in an old photo (or a whole
folder of them) and a few seconds later you have a colour version, at the full
resolution of the original. No account, no upload, no subscription.

![Billie Holiday, 1947, before and after](docs/example-holiday.jpg)

![The Tetons and the Snake River by Ansel Adams, 1942, before and after](docs/example-tetons.jpg)

<sub>Examples coloured by Tinge, unedited. Photos: William P. Gottlieb, Library of Congress (public domain);
Ansel Adams, U.S. National Archives (public domain).</sub>

## Download

Grab the latest version from the [Releases page](https://github.com/gsleraar-hue/tinge/releases/latest):

| System | File |
| --- | --- |
| Windows 10/11 | `Tinge-Setup-x.y.z.exe` (installer) or `Tinge-x.y.z-portable.exe` (no install) |
| macOS on Apple Silicon (M1 and later) | `Tinge-x.y.z-arm64.dmg` |

On first start Tinge downloads its colour model once (about 980 MB). After that
it works offline.

**macOS:** the app is not notarised by Apple (that costs $99 a year). The first
time, right-click Tinge in Applications and choose **Open**, then **Open** again.
Intel Macs are not supported: the AI runtime Tinge uses only ships for Apple Silicon.

**Windows:** SmartScreen may warn about an unknown publisher. Choose
**More info → Run anyway**.

## What it does

- **Two styles.** *Natural* gives calm, believable colours, the best choice for
  portraits and family photos. *Vivid* is richer and bolder, lovely for
  landscapes, streets and postcards.
- **Keeps every detail.** The AI only chooses the colours. Light and shade come
  straight from your original at full resolution, so nothing gets blurred or
  redrawn, and faces stay exactly as they were.
- **Before and after.** Drag across the photo to compare, or hold <kbd>Space</kbd>
  to see the original.
- **Fine-tuning.** Sliders for *Colour strength* and *Warmth* for when the result
  is a little too bold or too cool.
- **Batches.** Add as many photos as you like; they are coloured one by one.
  **Save all** writes them to a folder of your choice as `name (colour).jpg`.

Shortcuts: <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>O</kbd> add photos,
<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd> save, <kbd>↑</kbd> <kbd>↓</kbd> previous/next photo.

## How it works

Tinge runs [DDColor](https://github.com/piddnad/DDColor) (Kang et al., ICCV 2023),
a neural network trained on millions of colour photos, through
[ONNX Runtime](https://onnxruntime.ai/) on your processor.

1. The photo is scaled down to a grey 512 × 512 image and handed to the model.
2. The model answers with just the two colour channels (*a* and *b* in CIELAB).
3. Those channels are scaled back up and combined with the lightness (*L*) of
   the original photo at full size.

Step 3 is why the result is as sharp as the original: the model never touches
the detail, only the colour. On an ordinary laptop a photo takes about 4 to 8
seconds; loading the model the first time adds a few seconds.

Like every automatic colouriser, DDColor guesses. It knows skin, sky, grass,
brick and wood very well, but it cannot know the colour of a particular dress
or car. Use the sliders, or pick the other style, when a guess is off.

## Building it yourself

You need [Node.js](https://nodejs.org/) 22 or later.

```bash
npm install
npm start          # run from source
npm test           # check the colour maths
npm run dist       # Windows installer + portable exe in dist/
npm run dist-mac   # macOS dmg + zip in dist/ (on a Mac)
```

The GitHub Actions workflow in [.github/workflows/build.yml](.github/workflows/build.yml)
builds both platforms and publishes a release whenever a `v*` tag is pushed.

To test the whole pipeline without a window, point `TINGE_SELFTEST` at an
input and an output file. Tinge colours the photo, writes a report to
`selftest.json` in its data folder and quits:

```bash
TINGE_SELFTEST="old.jpg|coloured.jpg|natural" npx electron .
```

### Project layout

| File | What it does |
| --- | --- |
| `main.js` | Window, file dialogs, saving |
| `models.js` | Downloads the models and runs them with ONNX Runtime |
| `renderer/color.js` | Colour maths: model input, Lab conversion, recombining at full size |
| `renderer/app.js` | The interface: list, queue, before/after view, sliders |
| `dev/make-icon.js` | Draws the app icon (`npm run icon`) |

## Credits and licence

- Colourisation model: [DDColor](https://github.com/piddnad/DDColor) by Xiaoyang Kang et al.,
  Apache License 2.0. The ONNX exports are downloaded from the
  [FaceFusion assets](https://github.com/facefusion/facefusion-assets) release.
- AI runtime: [ONNX Runtime](https://github.com/microsoft/onnxruntime) by Microsoft, MIT License.
- Tinge itself: [MIT License](LICENSE).
