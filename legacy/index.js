/** typedef
 *
 * @type {Object} ToDo
 * @property {string} name
 * @property {string} desc
 * @property {[number]} creation
 * @property {[number]} completion
 * @property {[number]} running
 * @property {number} weight
 */


const http = require('http');
const finalhandler = require('finalhandler');

const serveStatic = require('serve-static');
const fs = require('fs')

const serve = serveStatic("./web");

const webServer = http.createServer(function (req, res) {
    const done = finalhandler(req, res);
    serve(req, res, done);
});

webServer.listen(8080, "127.0.0.2", () => {
    if (process.argv.includes("--open")) {
        const open = require('open');
        open('http://todo.local/');
    }
});


const WebSocketServer = require('websocket').server;

let localServer = http.createServer(function (request, response) {
    console.log((new Date()) + ' Received request for ' + request.url);
    response.writeHead(404);
    response.end();
});


localServer.listen(2048, "127.0.0.2");

let wsServer = new WebSocketServer({
    httpServer: localServer,
    autoAcceptConnections: false
});

function originIsAllowed() {
    return true;
}

const todoKeys = [
    "name",
    "desc",
    "creation",
    "completion",
    "running",
    "weight"
]

function copyTodo(from, to) {
    todoKeys.forEach(key => to[key] = from[key]);
}

let settings = (key, value) => {
    let defaultSettings = {lastPath: require('os').homedir()};
    if (!fs.existsSync("./settings.json")) {
        fs.writeFileSync("./settings.json", JSON.stringify(defaultSettings));
    }
    let text = fs.readFileSync("./settings.json");
    let json;
    if (text === "") {
        json = defaultSettings
    } else {
        json = JSON.parse(text);
    }
    if (key ==null) {
        return json;
    } else {
        json[key] = value;
        fs.writeFileSync("./settings.json", JSON.stringify(json));
    }
}

let requestHandler = (request) => {
    try {
        if (!originIsAllowed(request.origin)) {
            // Make sure we only accept requests from an allowed origin
            request.reject();
            return;
        }
        const connection = request.accept('remote-protocol', request.origin);
        connection.on('message', function (message) {
            try {
                let object = JSON.parse(message.utf8Data);
                switch (object.code) {
                    case "FOLDERS": {
                        if (!fs.existsSync(object.path)) {
                            object.path = "/"
                        }
                        let folders = fs.readdirSync(object.path);
                        let hasTodo = folders.find(child => child === "todo.json") != null;
                        connection.send(JSON.stringify({
                            code: "FOLDERS",
                            children: folders
                                .filter(item => !(/(^|\/)\.[^\/.]/g).test(item))
                                .filter(file => {
                                    try {
                                        return fs.statSync(object.path + '/' + file).isDirectory();
                                    } catch (e) {
                                        return false;
                                    }
                                }),
                            hasTodo: hasTodo,
                            path: object.path
                        }))
                        break;
                    }
                    case "OPEN": {
                        let folders = fs.readdirSync(object.path);
                        let hasTodo = folders.find(child => child === "todo.json") != null;
                        let json;
                        if (!hasTodo) {
                            json = {version: 1, todos: {}, days: {}};
                            fs.writeFileSync(object.path + "/" + "todo.json", JSON.stringify(json));
                        } else {
                            json = JSON.parse(fs.readFileSync(object.path + "/" + "todo.json"));
                        }
                        connection.send(JSON.stringify({
                            code: "TODOS",
                            todos: json.todos,
                            days: json.days,
                            path: object.path
                        }))
                        settings("lastPath", object.path);
                        break;
                    }
                    case "ADD_TODO":
                    case "EDIT_TODO": {
                        let newTodo = {};
                        copyTodo(object.todo, newTodo);
                        let json = JSON.parse(fs.readFileSync(object.path + "/" + "todo.json"));
                        json.todos[object.id] = newTodo;
                        fs.writeFileSync(object.path + "/" + "todo.json", JSON.stringify(json));
                        break;
                    }
                    case "DELETE_TODO": {
                        let todoID = object.id;
                        let json = JSON.parse(fs.readFileSync(object.path + "/" + "todo.json"));
                        for (let day of Object.values(json.days)) {
                            delete day.todos[todoID]
                        }
                        delete json.todos[todoID];
                        fs.writeFileSync(object.path + "/" + "todo.json", JSON.stringify(json));
                        break;
                    }
                    case "NEW_TIMES": {
                        let todoID = object.id;
                        let timeSpentPerDay = object.data;
                        let json = JSON.parse(fs.readFileSync(object.path + "/" + "todo.json"));
                        for (let dayIndex of Object.keys(timeSpentPerDay)) {
                            let day = json.days[dayIndex];
                            if (day == null) {
                                day = {todos: {}};
                                json.days[dayIndex] = day;
                            }
                            if (day.todos[todoID] == null) {
                                day.todos[todoID] = timeSpentPerDay[dayIndex] / 60;
                            } else {
                                day.todos[todoID] += timeSpentPerDay[dayIndex] / 60;
                            }
                        }
                        fs.writeFileSync(object.path + "/" + "todo.json", JSON.stringify(json));
                        break;
                    }
                    case "SETTINGS": {
                        connection.send(JSON.stringify({
                            code: "SETTINGS",
                            settings: settings()
                        }))
                    }
                }
            } catch (e) {
                console.log(e);
            }
        });
        connection.on('close', function () {
        
        });
        
    } catch (e) {
        console.error(e.stack);
    }
}

wsServer.on('request', requestHandler);