<div align="center">

<img src="public/favicon.svg" width="56" height="56" alt="Frame logo" />

# Frame

### Big ideas. Moving pictures.

A calm, creative workspace for turning your words, images, and references into AI videos.

[![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-39734D?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/Built_with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenRouter](https://img.shields.io/badge/Powered_by-OpenRouter-53634C?style=flat-square)](https://openrouter.ai/)
[![MIT License](https://img.shields.io/badge/License-MIT-87966A?style=flat-square)](LICENSE)

[Get started](#get-started) · [Take a look](#take-a-look) · [Common questions](#common-questions)

</div>

![Frame’s video studio, with prompt writing, model settings, and a cinematic preview area](docs/screenshots/studio-desktop.png)

## A little imagination goes a long way

Describe a scene, choose how it should look, and let your selected video model bring it to life. Frame starts with **Wan 3.0** and discovers other available video models directly from OpenRouter, so you can explore different creative engines in one place.

- **Start with words.** Write a prompt or borrow a starting point from the inspiration gallery.
- **Bring your own ingredients.** Drop in photos, video clips, or audio, and reuse them from your asset library.
- **Frame the scene.** Use an image to guide the first or last frame on models that support it.
- **Make it your own.** Choose duration, resolution, aspect ratio, and audio, with more controls when a model offers them.
- **Keep your creative flow.** Follow generation progress while working on your next idea. Run up to three generations at once.
- **Watch, download, revisit.** Preview finished clips, download your favorites, and find past generations in My creations.

No graphics card or local AI installation needed. OpenRouter handles the generation.

## Get started

You’ll need two things:

1. **[Node.js](https://nodejs.org/)** — version 22.12 or newer. The current LTS version is a good choice.
2. **An [OpenRouter API key](https://openrouter.ai/settings/keys)** and credits for generating videos. Think of the key as the connection between your studio and the video models.

### 1. Open the project

Clone this repository, or choose **Code → Download ZIP** on GitHub and unzip it. Open a terminal in the `GenVideoStudio` folder.

### 2. Start your studio

Run these commands, one at a time:

```bash
npm install
npm run dev
```

Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)** in your browser. Leave the terminal running while you use Frame.

### 3. Connect and create

Click **Connect OpenRouter** in the top-right corner, paste your API key, and connect. Then:

1. Describe the video you have in mind.
2. Add reference assets if you like.
3. Pick a model and adjust the video settings.
4. Click **Generate video**. Your progress and finished video appear in Preview.

When it’s ready, click **Download** to keep a copy.

> **Your first prompt:** “A slow camera push through a quiet forest at sunrise. Warm light filters through the trees, mist drifts over the path, and leaves move gently in the breeze.”

To open the studio another day, run `npm run dev` again. To stop it, press **Ctrl + C** in the terminal.

## Take a look

### Choose the right model for your idea

Search available models and compare their supported settings. The studio updates its controls when you choose a model.

![Frame’s searchable model picker showing video models from OpenRouter](docs/screenshots/model-picker.png)

<details>
<summary><strong>See the mobile layout</strong></summary>
<br />
<p>The studio adapts to smaller screens, with a collapsible menu and controls that stack naturally.</p>
<img src="docs/screenshots/studio-mobile.png" width="300" alt="Frame’s video studio on a phone-sized screen" />
</details>

<sub>Screenshots show the real interface. The forest photograph in the empty preview is inspiration imagery; your generated video appears there when it’s ready.</sub>

## A few small tips

| If you want… | Try… |
| --- | --- |
| A cinematic feel | Mention the camera movement, lighting, and mood. |
| A familiar starting image | Choose **Image to video** and add a first frame. |
| Guidance from several assets | Choose **References** and add your ingredients. |
| A vertical video | Pick **9:16** under Aspect ratio, when available. |
| A quick experiment | Start with a shorter clip and a lower resolution. |
| To try a variation | Find the generation in **My creations** and choose **Reuse prompt**. |

**Mac:** ⌘ + Enter · **Windows / Linux:** Ctrl + Enter — generate from the prompt field.

## Common questions

<details>
<summary><strong>Is Frame free?</strong></summary>

Frame is free, open-source software. Video generation uses your OpenRouter account and may cost money. The studio shows an estimate when the model’s pricing makes that possible, and the actual charge when OpenRouter reports it. Provider rates and reference inputs can affect the final price.

</details>

<details>
<summary><strong>Which files can I upload?</strong></summary>

Common image, video, and audio formats are supported, including JPG, PNG, WebP, GIF, AVIF, MP4, MOV, WebM, MP3, WAV, OGG, FLAC, M4A, and AAC. You can upload up to 12 files at once, with a limit of 25 MB each. A generation can include up to 50 MB of reference files in total.

Images can be used as references or, when supported, first and last frames. Video and audio guidance requires a compatible provider, such as BytePlus with Seedance 2 or newer. Other providers may ignore those references. Frame images and reference assets are separate generation modes, so use one mode at a time.

</details>

<details>
<summary><strong>Why do the options change between models?</strong></summary>

Each model has its own capabilities. Frame reads those from OpenRouter and shows the available choices. A disabled setting means that model does not expose that control. Providers can also have additional restrictions, which appear as an error if a request cannot be served.

</details>

<details>
<summary><strong>Where do my key and files go?</strong></summary>

A key entered in the app stays in the server’s memory and expires after 24 hours of inactivity. Restarting the server clears it. Frame never saves that key in browser storage or on disk.

Uploads and generation history live in the local `data` folder. Your browser session identifies your workspace, so reopen Frame in the same browser to see it again. Your prompt draft is saved in that browser. References are sent to OpenRouter and the selected provider when you generate; their data policies apply.

Generated videos are fetched from OpenRouter. Download the clips you want to keep, since availability depends on the service’s retention period.

</details>

<details>
<summary><strong>Can I close the browser while a video is generating?</strong></summary>

Yes, as long as the Node.js server stays running. It keeps checking active jobs in the background. If you restart the server, reconnect your key and open the studio to resume status checks. Closing the browser does not cancel a submitted generation.

</details>

<details>
<summary><strong>Something isn’t working. What should I try?</strong></summary>

- **The page won’t open:** make sure `npm run dev` is still running and use the local address printed in the terminal.
- **Your key won’t connect:** check that it’s an OpenRouter key, that it’s active, and that you copied the whole value.
- **A generation fails:** read the error in the preview. Check your credits, try a different setting or model, or adjust the prompt.
- **A video won’t play:** reconnect your key, then try downloading the video. Older outputs may no longer be available from OpenRouter.
- **The model list won’t load:** check your internet connection and use **Retry model discovery**.

</details>

## Want to go a little further?

For environment settings, production builds, tests, and how the project is organized, see the **[development guide](docs/DEVELOPMENT.md)**. The default setup is a personal studio running on your computer; hosting a shared service needs additional sign-in and deployment setup.

Found a bug or have an idea? Open an issue. Contributions are welcome.

## License & credits

Released under the **[MIT license](LICENSE)**. You can use, modify, and share Frame, including for commercial projects, under that license. Model access, generated content, and third-party assets remain subject to their respective terms.

Built with React, TypeScript, Node.js, and Express. Video generation by [OpenRouter](https://openrouter.ai/), icons by [Lucide](https://lucide.dev/), and inspiration photography from [Unsplash](https://unsplash.com/).

<div align="center">
<sub>Made for the way you imagine.</sub>
</div>
