# Deterministic Physics Dice — Client/Server Architecture

This project is the current working dice roller split into two clear responsibilities.

## Architecture

### Server

The Node server is authoritative for roll preparation only:

- receives a roll request containing the expression and selected skin
- parses the expression using the same syntax as the current roller
- expands every dice term into individual dice
- assigns each die an explicit ID and zero-based `index`
- generates one roll seed
- derives each die seed using the **same `mixSeed(rollSeed, index)` mechanism** used by the client build
- sends the roll manifest to every connected client

The server does **not** run Three.js or Rapier physics.

### Client

The client remains responsible for the existing working dice system:

- Three.js rendering
- Rapier rigid-body simulation
- dice GLBs and skins
- current die sizes
- current camera
- current table and invisible walls
- current D6 cuboid / other convex-hull collider behavior
- current D4 bottom-face rule
- current face detection
- current keep-highest / keep-lowest evaluation
- current visual result and total

The client receives the server's roll manifest and feeds its exact `die.id`, `die.index`, `die.seed`, and other metadata into the existing physics pipeline.

## Critical seed relationship

The server uses:

```js
const dieSeed = mixSeed(rollSeed, index);
```

The client uses the server-provided `die.seed` directly for:

```js
const pose = makeRollPose(die.seed, die.index, diceCount);
```

The `index` is preserved because the existing `makeRollPose()` uses the die index when deriving its deterministic starting placement. Do not reorder dice between the server manifest and the client physics creation.

## Run

Requirements:

- Node.js 18+ recommended
- npm

From the project root:

```bash
cd server
npm install
npm start
```

The server will listen on:

```text
http://localhost:3000
```

Open that URL in the browser. Do **not** use `python -m http.server` for this build because the WebSocket endpoint is provided by the Node server.

## Multiple devices

The Node server serves the client files and WebSocket endpoint from the same port. To test another device on the same LAN, use your PC's LAN IP, for example:

```text
http://192.168.1.25:3000
```

For internet-accessible testing, expose port 3000 with your tunneling tool of choice.

## Roll request flow

```text
Client
  ↓ { type: "roll", expression, skin }
Server
  ↓ parse + expand + IDs + seeds
Server
  ↓ broadcast one roll manifest
All clients
  ↓ existing deterministic physics pipeline
Rapier
  ↓ natural simulation
Face detection
  ↓ individual results
Expression evaluation
  ↓ total
```
