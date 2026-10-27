# Sprint Board — Drawdy extension

A Jira-style sprint board that lives on your Drawdy canvas: tickets you drag across Backlog, To do, In progress, Testing and Done, with assignees, priorities and filters, and a **Complete sprint** button that files the finished work in a version log.

Install the extension, click its toolbar button, create a board, and add tickets from the panel or drag them around on the canvas.

## How to use

1. **Create a board.** Click the Sprint Board button (three columns) in the toolbar. Enter a project key such as `LAOR` and a first sprint name. A version like `v0.0.6-beta` works well, because the next sprint is named by bumping it. The board appears where you're looking.
2. **Add tickets.** Click **Create ticket** in the panel. Each ticket gets a key (`LAOR-001`, `LAOR-002`, …), a type (Feature, Bug, Chore), a priority (P1 now, P2 soon, P3 later), optional story points, and an assignee.
3. **Move work along.** Drag a card into another column on the canvas, or change its status in the panel. Cards snap into place, and dropping between two cards puts it there.
4. **Assign.** In a ticket, pick anyone on the board, use **Assign to me**, or type a name under **Someone else…**.
5. **Filter.** Search keys, titles and descriptions; filter by assignee, type and priority, or **Only my issues**. **Show on board** selects the matching cards and moves the view to them.
6. **Complete the sprint.** **Complete sprint** moves every Done ticket into the **Sprint archive · version log** frame below the board, as one entry with your release notes. Unfinished tickets carry over to the next sprint, or go back to the backlog if you choose. The next sprint starts today.

| Interaction | What happens |
| --- | --- |
| Drag a card to another column | Its status changes and the column re-sorts |
| Drop a card outside the columns | It snaps back to where it was |
| Select one card while editing in the panel | The editor switches to that ticket |
| Delete a card on the canvas | The ticket is deleted (undo brings it back) |
| Right-click > Sprint board > Turn selection into tickets | Selected sticky notes or cards become tickets |
| Releases tab | Every completed sprint, newest first, with its finished tickets |

### Importing what you already have

Select sticky notes or cards and choose **Turn selection into tickets**, from the right-click menu or from the Backlog tab. The first line becomes the title. A key in front, as in `LAOR-007 · Slide notes`, is kept when it's free. A line such as `Feature · P3` sets the type and priority. A card sitting inside a box labelled *To do*, *In progress*, *Testing*, *Done* or *Backlog* gets that status. The originals stay on the canvas.

### Where the data is

Everything is stored on the board itself, in the elements' data: each card holds its ticket, and the board frame holds the sprint and the version log. On a cloud board, everyone sees the same tickets, and copying the board copies its tickets. The extension keeps nothing on your device.

### Permissions

- **Canvas (`scene`)** to draw the board and read your cards. Asked the first time you open the panel.
- **Interface (`dom`)** for the toolbar button, the right-click menu and the panel.
- **People on the board (`collaboration`)** to offer the people on the board as assignees. Asked the first time you open a ticket. Without it, you type assignee names.

## Development

No npm dependencies: the build uses Node's built-in TypeScript type stripping (Node 22.13 or later).

```bash
npm run dev     # dev server on http://localhost:5173 that Drawdy hot-reloads from
npm run build   # writes dist/peamz4-sprint-board.drawdyx
npm test        # runs the driver against an in-memory stand-in for Drawdy
```

To try it, open a **local** board on drawdy.io, press `Ctrl+K` (`⌘K` on macOS), run **Add extension dev server**, and enter `http://localhost:5173`.

- `src/index.ts`: toolbar button, menus, panel messages, and the ticket and sprint operations.
- `src/board.ts`: reading the board from the canvas, element layouts, and the snap-to-columns pass.
- `src/model.ts`: tickets, sprints, keys, version bumping and import parsing.
- `src/webview/panel.html`: the panel UI. The build turns it into `src/webview-html.ts`. Commit both, because Drawdy's own build reads only the `.ts`.
