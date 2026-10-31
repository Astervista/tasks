let subFolders = []
let path = []
let withTodo = false;
let todoElement;
let blocked = true;
let open = false;
let todos = {};
let days = {};
let currentComparator = (taskA, taskB) => taskA.id - taskB.id;
/** @type {WebSocket}*/
let socket;
let socketError = 0;

let particleInterval;

let oldParseFloat = parseFloat;
parseFloat = string => {
    if (/^[0-9]+(.[[0-9]+)?$/.test(string)) {
        return oldParseFloat(string);
    } else {
        return NaN;
    }
}

function formatMinutes(minutes, showSeconds = false) {
    let seconds;
    if (showSeconds) {
        seconds = Math.floor((minutes % 1) * 60);
    }
    minutes = Math.floor(minutes);
    let pieces = [];
    if (Math.floor(minutes / 60) !== 0) {
        pieces.push(Math.floor(minutes / 60) + " h")
    }
    if (minutes % 60 !== 0) {
        pieces.push(minutes % 60 + " min")
    }
    if ((showSeconds) && (seconds !== 0)) {
        pieces.push(seconds + " s")
    }
    if (pieces.length === 0) {
        return "0 min"
    }
    return pieces.join(" ");
}

function getDateFromNumbers(date, time) {
    let pieces = [];
    if (isFinite(date)) {
        pieces.push(Math.floor(date / (12 * 32)) + "-" + ("0" + Math.floor((date / (32)) % 12 + 1)).substr(-2, 2) + "-" + ("0" + (date % 32)).substr(-2, 2))
    }
    if (isFinite(time)) {
        if ((time < 60 * 13 * 60) && (time >= 60 * 12 * 60)) {
            pieces.push("12:" + ("0" + Math.floor(time / 60) % 60).substr(-2, 2) + ":" + ("0" + (time % 60)).substr(-2, 2) + " PM")
        } else {
            pieces.push(("0" + Math.floor((time / (60 * 60)) % 12)).substr(-2, 2) + ":" + ("0" + (Math.floor(time / 60) % 60)).substr(-2, 2) + ":" + ("0" + (time % 60)).substr(-2, 2) + (time / (60 * 60) % 24 >= 12 ? " PM" : " AM"))
        }
    }
    return pieces.join(" ")
}


function getDateObjectFromNumbers(numbers) {
    let then = new Date();
    then.setFullYear(Math.floor(numbers[0] / (12 * 32)));
    then.setMonth(Math.floor((numbers[0] / (32)) % 12));
    then.setDate(numbers[0] % 32);
    then.setHours(Math.floor(numbers[1] / (60 * 60)))
    then.setMinutes(Math.floor(numbers[1] / (60)) % 60)
    then.setSeconds(numbers[1] % 60)
    return then;
}

function addDays(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function getNumbersFromDate(when) {
    return [
        when.getFullYear() * 12 * 32 + when.getMonth() * 32 + when.getDate(),
        when.getHours() * 60 * 60 + when.getMinutes() * 60 + when.getSeconds()
    ];
}

function compareTimes(dateA, dateB) {
    if (dateA == null) {
        if (dateB != null) {
            return -1
        } else {
            return 0;
        }
    } else if (dateB == null) {
        return 1
    }
    let result = dateA[0] - dateB[0];
    if (result !== 0) {
        return result;
    } else {
        return dateA[1] - dateB[1];
    }
}

adjustSubFolder = (subFolder, level = path.length, clickable = true) => {
    subFolder.element.css("display", subFolder.visible ? "" : "none");
    if (subFolder.selected) {
        subFolder.element.addClass("selected")
    } else {
        subFolder.element.removeClass("selected")
    }
    level = "s" + level % 7
    subFolder.element.attr("sub-level", level)
    if (clickable) {
        subFolder
            .element
            .click(() => {
                let selectedIndex = subFolders.findIndex(a => a.selected);
                if (selectedIndex !== -1) {
                    subFolders[selectedIndex].selected = false;
                }
                subFolder.selected = true;
                let e = jQuery.Event("keyup");
                e.key = "Enter"
                $("#address")
                    .trigger(e)
            })
    }
}

setupFolders = (names, level = 0, hasTodo = false) => {
    
    blocked = false;
    open = false;
    withTodo = hasTodo;
    $("#address").show();
    $("#address-space").hide();
    $("#address-close").hide();
    let suggestionBar = $("#suggestion-bar")
    suggestionBar.show();
    suggestionBar.empty()
    todoElement = $("<span class='subTodo selected'></span>").text(hasTodo ? "Open ToDo" : "Create ToDo")
    todoElement.click(() => {
        subFolders.forEach(folder => folder.selected = false)
        let e = jQuery.Event("keyup");
        e.key = "Enter"
        $("#address")
            .trigger(e)
    })
    suggestionBar.append(todoElement)
    subFolders = names.sort((a, b) => a.localeCompare(b)).map(a => {
        return {name: a}
    });
    subFolders.forEach((folder, index) => {
        folder.selected = false;
        folder.visible = true;
        folder.element = $("<span class='sub-folder'></span>").text(folder.name)
        adjustSubFolder(folder, level)
        suggestionBar.append(folder.element)
    })
}
generateNames = () => {
    let result = [];
    let length = Math.floor(Math.random() * 30);
    while (result.length < length) {
        let stringLength = Math.floor(Math.random() * 10) + 5;
        let string = "";
        let vowel = Math.random() < 0.7;
        while (string.length < stringLength) {
            vowel = !vowel;
            if (vowel) {
                string += "aeio".charAt(Math.floor(Math.random() * 4));
            } else {
                string += "cdflmpstrvn".charAt(Math.floor(Math.random() * 11));
            }
        }
        result.push(string);
    }
    return result;
}

pauseTodo = (todo, update = true) => {
    if (todo.status === 2) {
        let now = new Date();
        let then = getDateObjectFromNumbers(todo.running);
        let thisMoment = getNumbersFromDate(now);
        if (then.getTime() > now.getTime()) {
            throw new Error("Date conflict. Cannot finish before being started!")
        }
        let timeSpentPerDay = {};
        if (todo.running[0] === thisMoment[0]) {
            timeSpentPerDay[thisMoment[0]] = thisMoment[1] - todo.running[1]
        } else {
            timeSpentPerDay[todo.running[0]] = 24 * 60 * 60 - todo.running[1]
            timeSpentPerDay[thisMoment[0]] = thisMoment[1]
            let someDate = then;
            someDate = addDays(someDate, 1);
            while (
                (someDate.getFullYear() !== now.getFullYear()) ||
                (someDate.getMonth() !== now.getMonth()) ||
                (someDate.getDate() !== now.getDate())) {
                
                let thisDay = someDate.getFullYear() * 12 * 32 + someDate.getMonth() * 32 + someDate.getDate();
                timeSpentPerDay[thisDay] = 24 * 60 * 60;
                someDate = addDays(someDate, 1);
            }
        }
        let todoID = getTodoID(todo);
        for (let dayIndex of Object.keys(timeSpentPerDay)) {
            let day = days[dayIndex];
            if (day == null) {
                day = {todos: {}};
                days[dayIndex] = day;
            }
            todo.timeSpent += timeSpentPerDay[dayIndex] / 60;
            if (day.todos[todoID] == null) {
                day.todos[todoID] = timeSpentPerDay[dayIndex] / 60;
            } else {
                day.todos[todoID] += timeSpentPerDay[dayIndex] / 60;
            }
        }
        todo.running = null;
        if (update) {
            socket.send(JSON.stringify({
                code: "EDIT_TODO",
                id: todoID,
                path: "/" + path.map(a => a.name).join("/"),
                "todo": todo
            }))
        }
        socket.send(JSON.stringify({
            code: "NEW_TIMES",
            id: todoID,
            path: "/" + path.map(a => a.name).join("/"),
            "data": timeSpentPerDay
        }))
        if (update) {
            todoNewValues(todo, getMaxWeight());
        }
    }
}

function orderTodos(comparator) {
    currentComparator = comparator;
    Object.values(todos).sort(comparator).forEach((todo, index) => todo.line.css("order", index));
}

function getMaxWeight() {
    return Object.values(todos).reduce((a, b) => Math.max(a, b.weight), -Infinity);
}

function editTodo(container, todo) {
    if (container.find(".task-line-details").length !== 0) {
        $(".task-line-details").remove();
        $(".task-line-buttons").remove();
    } else {
        $(".task-line-details").remove();
        $(".task-line-buttons").remove();
        container.append($("<div class='task-line-details'></div>").text(todo.desc));
        let buttons = $("<div class='task-line-buttons'></div>");
        container.append(buttons);
        buttons.append($("<span class='task-line-button button button-edit'>Edit</span>").click(() => {
            
            let dialog = $(
                '<div class="modal">' +
                '<div class="modal-content">' +
                '<h4 class="no-select">Edit ToDo</h4>' +
                '<div class="input-field col s6" style="margin-top: 30px; margin-bottom: 0">\n' +
                '<input id="title" type="text">\n' +
                '<label for="title">Title</label>\n' +
                '<span class="helper-text" data-error="Please insert a valid title">Insert a title for the ToDo</span>' +
                '</div> ' +
                '<div class="input-field col s6" style="margin-top: 30px; margin-bottom: 0">\n' +
                '<input id="weight" type="text">\n' +
                '<label for="weight">Weight</label>\n' +
                '<span class="helper-text" data-error="Please insert a valid weight">Insert a weight signifying the ToDo difficulty</span>' +
                '</div> ' +
                '<div class="input-field col s6" style="margin-top: 20px; margin-bottom: 0">' +
                '<textarea id="description" class="materialize-textarea" style="height: 100px"></textarea>' +
                '<label for="description">Description</label>\n' +
                '</div> ' +
                '</div>' +
                '<div class="modal-footer">' +
                '<a class="modal-close button white-text" id="ok-btn">OK</a>' +
                '<a class="modal-close button white-text">Cancel</a>' +
                '</div>' +
                '</div>');
            dialog.find("#title").val(todo.name);
            let weight = dialog.find("#weight");
            weight
                .val(todo.weight)
                .on("input", () => {
                    if (!/$[0-9.]*^/.test(weight.val())) {
                        weight.val(weight.val().replace(/[^0-9.]/, ""));
                    }
                })
                .keydown((e) => {
                    let delta = 0;
                    if (e.key === "ArrowUp") {
                        delta = 1;
                    } else if (e.key === "ArrowDown") {
                        delta = -1;
                    }
                    if (delta !== 0) {
                        e.preventDefault();
                        let i = parseFloat(weight.val());
                        if (!isNaN(i) && isFinite(i)) {
                            if (e.shiftKey) {
                                weight.val(Math.max(1, i + 10 * delta))
                            } else {
                                weight.val(Math.max(1, i + delta))
                            }
                        }
                    }
                    
                });
            dialog.find("#description").val(todo.desc);
            dialog.find("#ok-btn").click(() => {
                let newTitle = dialog.find("#title").val();
                if (newTitle !== "") {
                    todo.name = newTitle.replace(/[\n\r]/, "");
                }
                let newWeight = parseFloat(dialog.find("#weight").val());
                if (!isNaN(newWeight) && isFinite(newWeight)) {
                    todo.weight = newWeight;
                }
                todo.desc = dialog.find("#description").val();
                let maxWeight = getMaxWeight();
                for (let someTodo of Object.values(todos)) {
                    todoNewValues(someTodo, maxWeight)
                }
                socket.send(JSON.stringify({
                    code: "EDIT_TODO",
                    id: getTodoID(todo),
                    path: "/" + path.map(a => a.name).join("/"),
                    "todo": todo
                }))
            })
            $("body").append(dialog)
            dialog.modal({onCloseEnd: () => dialog.remove()});
            M.updateTextFields();
            M.Modal.getInstance(dialog).open();
        }))
        let getDoRunClick = (verbIng, verb) => {
            return () => {
                let toPause = Object.values(todos).find((todo) => todo.status === 2);
                let doStartResume = () => {
                    if (toPause != null) {
                        pauseTodo(toPause);
                    }
                    let now = new Date();
                    todo.running = getNumbersFromDate(now);
                    todo.completion = null;
                    todoNewValues(todo, getMaxWeight());
                    socket.send(JSON.stringify({
                        code: "EDIT_TODO",
                        id: getTodoID(todo),
                        path: "/" + path.map(a => a.name).join("/"),
                        "todo": todo
                    }))
                }
                if (toPause != null) {
                    let dialog = $(
                        '<div class="modal">' +
                        '<div class="modal-content">' +
                        '<h4 class="no-select">Another ToDo is running</h4>' +
                        '<p></p>' +
                        '</div>' +
                        '<div class="modal-footer">' +
                        '<a class="modal-close button white-text" style="background-color: forestgreen" id="ok-btn">' + verb + '</a>' +
                        '<a class="modal-close button white-text">Cancel</a>' +
                        '</div>' +
                        '</div>');
                    dialog.find("#ok-btn").click(() => {
                        doStartResume();
                    })
                    dialog.find("p").text('Another ToDo is already running (' + todo.name + '). ' + verbIng + ' this one will pause the other. Do you want to proceed?')
                    $("body").append(dialog)
                    dialog.modal({onCloseEnd: () => dialog.remove()});
                    M.updateTextFields();
                    M.Modal.getInstance(dialog).open();
                } else {
                    doStartResume();
                }
            }
        }
        if (todo.completion == null) {
            if (todo.running == null) {
                buttons.append($("<span class='task-line-button button button-play'></span>").text(todo.timeSpent === 0 ? "Start" : "Resume").click(
                    getDoRunClick((todo.timeSpent === 0 ? 'Starting' : "Resuming"), (todo.timeSpent === 0 ? 'Start' : "Resume"))
                ))
            } else {
                buttons.append($("<span class='task-line-button button button-pause'>Pause</span>").click(() => {
                    pauseTodo(todo)
                }))
                buttons.append($("<span class='task-line-button button button-reset'>Reset timer</span>").click(() => {
                    todo.running = null;
                    socket.send(JSON.stringify({
                        code: "EDIT_TODO",
                        id: getTodoID(todo),
                        path: "/" + path.map(a => a.name).join("/"),
                        "todo": todo
                    }))
                    todoNewValues(todo, getMaxWeight())
                }))
            }
            buttons.append($("<span class='task-line-button button button-done'>Done</span>").click(() => {
                if (todo.status === 2) {
                    pauseTodo(todo, false);
                }
                todo.completion = getNumbersFromDate(new Date());
                socket.send(JSON.stringify({
                    code: "EDIT_TODO",
                    id: getTodoID(todo),
                    path: "/" + path.map(a => a.name).join("/"),
                    "todo": todo
                }))
                todoNewValues(todo, getMaxWeight());
                let allCompleted = Object.values(todos).findIndex((todo) => todo.status !== 3) === -1;
                if (allCompleted) {
                    confetti();
                }
            }))
        } else {
            buttons.append($("<span class='task-line-button button button-restart'>Reopen</span>").click(getDoRunClick("Reopening", "Reopen")))
        }
        buttons.append($("<span class='task-line-button button button-delete'>Delete</span>").click(() => {
            
            let dialog = $(
                '<div class="modal">' +
                '<div class="modal-content">' +
                '<h4 class="no-select">Delete ToDo?</h4>' +
                '<p>Are you sure to delete the ToDo? This action cannot be undone!</p>' +
                '</div>' +
                '<div class="modal-footer">' +
                '<a class="modal-close button white-text" style="background-color: crimson" id="ok-btn">Delete</a>' +
                '<a class="modal-close button white-text">Cancel</a>' +
                '</div>' +
                '</div>');
            dialog.find("#ok-btn").click(() => {
                todo.line.remove();
                let todoID = getTodoID(todo);
                delete todos[todoID];
                for (let day of Object.values(days)) {
                    delete day.todos[todoID]
                }
                socket.send(JSON.stringify({
                    code: "DELETE_TODO",
                    id: todoID,
                    path: "/" + path.map(a => a.name).join("/")
                }))
            })
            $("body").append(dialog)
            dialog.modal({onCloseEnd: () => dialog.remove()});
            M.updateTextFields();
            M.Modal.getInstance(dialog).open();
        }))
    }
}

function getTodoID(todo) {
    for (let key of Object.keys(todos)) {
        if (todos[key] === todo) {
            return key;
        }
    }
    return null;
}

let currentTimerStart = null;
let currentTimeCountAtStart = 0;
let runningTimeout = null;

function reloadStatistics() {
    $("#status-left-ext").empty()
        .append($("<span style='margin-left: 5px'>Current running ToDo:</span>")
            .text(Object.values(todos).length))
        .append($("<span style='margin-left: 5px; color: #AAA'></span>").text("total todos"))
    $("#status-left-int").empty()
        .append(
            $(
                "<span style='display: flex; align-items: center'>" +
                "<span class='material-icons green-text' style='margin-left: 20px'>done</span>" +
                "<span class='status-bar-number-span' style='margin-left: 6px'>" + Object.values(todos).filter(todo => todo.status === 3).length + "</span>" +
                "</span>"))
        .append(
            $(
                "<span style='display: flex; align-items: center'>" +
                "<span class='material-icons amber-text' style='margin-left: 20px'>pause</span>" +
                "<span class='status-bar-number-span' style='margin-left: 10px'>" + Object.values(todos).filter(todo => todo.status === 1).length + "</span>" +
                "</span>"))
        .append(
            $(
                "<span style='display: flex; align-items: center'>" +
                "<span class='material-icons red-text'style='margin-left: 20px'>stop</span>" +
                "<span class='status-bar-number-span' style='margin-left: 6px'>" + Object.values(todos).filter(todo => todo.status === 0).length + "</span>" +
                "</span>"))
    
    let waitTodo = Object.values(todos).find((todo) => todo.status === 2);
    if (runningTimeout != null) {
        clearTimeout(runningTimeout);
    }
    if (waitTodo != null) {
        $("#status-right-int").empty()
            .append($("<span style='margin-left: 5px; color: #AAA'>Current running ToDo:</span>"))
            .append($("<span style='margin-left: 5px; font-style: italic'></span>").text(Object.values(todos).find((todo) => todo.status === 2).name))
        $("#status-right-ext").empty()
            .append($("<span style='margin-left: 5px; color: #AAA'>Current todo running time:</span>"))
            .append($("<span style='margin-left: 5px;' class='status-bar-timer-a'></span>"))
            .append($("<span style='margin-left: 5px; color: #DDD' class='status-bar-timer-b'></span>"))
        
        let now = new Date();
        let then = getDateObjectFromNumbers(waitTodo.running);
        let thisMoment = getNumbersFromDate(now);
        if (then.getTime() > now.getTime()) {
            throw new Error("Date conflict. Cannot finish before being started!")
        }
        currentTimeCountAtStart = 0;
        if (waitTodo.running[0] === thisMoment[0]) {
            currentTimeCountAtStart = thisMoment[1] - waitTodo.running[1]
        } else {
            currentTimeCountAtStart += 24 * 60 * 60 - waitTodo.running[1]
            currentTimeCountAtStart += thisMoment[1]
            let someDate = then;
            someDate = addDays(someDate, 1);
            while (
                (someDate.getFullYear() !== now.getFullYear()) ||
                (someDate.getMonth() !== now.getMonth()) ||
                (someDate.getDate() !== now.getDate())) {
                
                currentTimeCountAtStart += 24 * 60 * 60;
                someDate = addDays(someDate, 1);
            }
        }
        currentTimerStart = now;
        let callback = () => {
            $(".status-bar-timer-a").text(formatMinutes((currentTimeCountAtStart + (new Date().getTime() - currentTimerStart.getTime()) / 1000) / 60, true))
            $(".status-bar-timer-b").text("(" + formatMinutes((currentTimeCountAtStart + (new Date().getTime() - currentTimerStart.getTime()) / 1000) / 60 + waitTodo.timeSpent, true) + ")")
            runningTimeout = setTimeout(callback, 1000)
        }
        callback();
    } else {
        
        $("#status-right-int").empty()
            .append($("<span style='margin-left: 5px; color: #AAA'>No todo is currently running</span>"))
        $("#status-right-ext").empty()
            .append($("<span style='margin-left: 5px; color: #AAA'>Total running time:</span>"))
            .append($("<span style='margin-left: 5px;' class='status-bar-timer-c'></span>").text(formatMinutes(Object.values(todos).reduce((sum, task) => sum + task.timeSpent, 0))))
    }
}

function todoNewValues(todo, maxWeight, doReloadStatistics = true) {
    $(".task-line-details").remove();
    $(".task-line-buttons").remove();
    let line = todo.line;
    line.find(".task-line-name").text(todo.name)
    line.find(".task-line-creation").text(getDateFromNumbers(todo.creation[0], todo.creation[1]))
    if (todo.running != null) {
        line
            .find(".task-line-running")
            .removeClass("material-icons")
            .removeClass("green-text")
            .removeClass("red-text")
            .text(getDateFromNumbers(todo.running[0], todo.running[1]));
    } else {
        if (todo.completion != null) {
            line
                .find(".task-line-running")
                .addClass("material-icons")
                .addClass("green-text")
                .removeClass("red-text")
                .text("done");
        } else {
            line
                .find(".task-line-running")
                .addClass("material-icons")
                .removeClass("green-text")
                .addClass("red-text")
                .text("close");
        }
    }
    if (todo.completion != null) {
        line
            .find(".task-line-completion")
            .removeClass("material-icons")
            .removeClass("amber-text")
            .removeClass("red-text")
            .removeClass("lime-text")
            .text(getDateFromNumbers(todo.completion[0], todo.completion[1]));
    } else {
        if (todo.running != null) {
            line
                .find(".task-line-completion")
                .addClass("material-icons")
                .removeClass("amber-text")
                .removeClass("red-text")
                .addClass("lime-text")
                .text("hourglass_bottom");
        } else {
            if (todo.timeSpent === 0) {
                line
                    .find(".task-line-completion")
                    .addClass("material-icons")
                    .removeClass("amber-text")
                    .addClass("red-text")
                    .removeClass("lime-text")
                    .text("hourglass_empty")
            } else {
                line
                    .find(".task-line-completion")
                    .addClass("material-icons")
                    .addClass("amber-text")
                    .removeClass("red-text")
                    .removeClass("lime-text")
                    .text("hourglass_top")
            }
        }
    }
    line.find(".task-line-weight").empty()
        .append(
            $("<span></span>")
                .text(todo.weight)
                .addClass("task-line-weight-back"))
        .append(
            $("<span></span>")
                .text(todo.weight)
                .css("width", (todo.weight / maxWeight * 100).toFixed(4) + "%")
                .addClass("task-line-weight-progress"));
    if (todo.timeSpent !== 0) {
        line
            .find(".task-line-counter")
            .removeClass("material-icons")
            .removeClass("red-text")
            .text(formatMinutes(todo.timeSpent));
    } else {
        line
            .find(".task-line-counter")
            .addClass("material-icons")
            .addClass("red-text")
            .text("close");
    }
    let status = line.find(".task-line-status")
    if (todo.completion != null) {
        status
            .text("done")
            .addClass("green-text")
            .removeClass("lime-text")
            .removeClass("text-lighten-1")
            .removeClass("amber-text")
            .removeClass("red-text")
        todo.status = 3;
    } else {
        if (todo.running != null) {
            status
                .text("play_arrow")
                .removeClass("green-text")
                .addClass("lime-text")
                .addClass("text-lighten-1")
                .removeClass("amber-text")
                .removeClass("red-text")
            todo.status = 2;
        } else {
            if (todo.timeSpent !== 0) {
                status
                    .text("pause")
                    .removeClass("green-text")
                    .removeClass("lime-text")
                    .removeClass("text-lighten-1")
                    .addClass("amber-text")
                    .removeClass("red-text")
                todo.status = 1;
            } else {
                status
                    .text("stop")
                    .removeClass("green-text")
                    .removeClass("lime-text")
                    .removeClass("text-lighten-1")
                    .removeClass("amber-text")
                    .addClass("red-text")
                todo.status = 0;
            }
        }
    }
    if (doReloadStatistics === true) {
        reloadStatistics();
    }
}

function createTodo(todo, maxWeight, todoID) {
    let container = $("<div class='task-group'></div>");
    let line = $("<div class='task-line'></div>");
    container.append(line);
    todo.line = container;
    todo.timeSpent = Object.values(days).reduce((sum, obj) => sum + (obj.todos[todoID] != null ? obj.todos[todoID] : 0), 0);
    line.append($("<span class='task-line-name'></span>"));
    line.append($("<span class='task-line-creation'></span>"));
    line.append($("<span class='task-line-running'></span>"));
    line.append($("<span class='task-line-completion'></span>"));
    line.append($("<span class='task-line-weight'></span>"))
    line.append($("<span class='task-line-counter'></span>"))
    line.append($("<span class='task-line-status material-icons'></span>").css("padding-left", "13px"));
    todoNewValues(todo, maxWeight, false);
    line.click(() => {
        editTodo(container, todo);
    })
    return container;
}

function setupLines() {
    let tasks = $("#tasks");
    tasks.empty();
    open = true;
    let maxWeight = getMaxWeight();
    for (let todoID of Object.keys(todos)) {
        let todo = todos[todoID];
        let line = createTodo(todo, maxWeight, todoID);
        tasks.append(line)
    }
    reloadStatistics()
    $("#status-bar").css("display", "flex");
}

function confetti() {
    if (particleInterval != null) {
        clearInterval(particleInterval);
    }
    let effectsContainer = $("#effects");
    effectsContainer.empty();
    let particles = [];
    let frameLength = 1000 / 30;
    let frameLengthScaled = frameLength * 3;
    let bias = Math.random() * 0.3 + 0.35;
    
    let offsetHeight = effectsContainer[0].offsetHeight;
    
    function generateParticle() {
        let particle = {};
        let direction = Math.random() > bias;
        particle.newConfetti = $("<span class='particle'></span>");
        particle.newConfetti.css("background-color",
            "hsl(" +
            (Math.random() * 359) + ", " +
            (Math.random() * 20 + 80) + "%, " +
            (Math.random() * 20 + 50) + "%)");
        particle.newConfetti.css("width", Math.random() * 8 + 6 + "px");
        particle.newConfetti.css("height", Math.random() * 8 + 6 + "px");
        particle.newConfetti.css("border-radius", Math.random() * 8 + "px");
        particle.newConfetti.css("display", "none");
        effectsContainer.append(particle.newConfetti);
        particle.position = [(direction ? 0 : 1) * effectsContainer[0].offsetWidth, offsetHeight];
        let angle = 1.1 * Math.random() + 0.4
        let velocityScaling = (0.4 + Math.random() * 0.8);
        particle.velocity = [
            (direction ? 1 : -1)
            * frameLengthScaled * Math.cos(angle) * velocityScaling,
            -frameLengthScaled * Math.sin(angle) * velocityScaling];
        particle.terminal = 0.3 * frameLengthScaled * (0.8 + Math.random() * 0.4);
        particle.drag = 1 - 0.003 * frameLength * (0.8 + Math.random() * 0.4);
        particle.gravity = 7e-3 * frameLengthScaled * (0.8 + Math.random() * 0.4);
        particle.twirlAmpl = offsetHeight * 0.01 * (0.8 + Math.random() * 0.4);
        particle.angleX = Math.random() * 6;
        particle.angleY = Math.random() * 6;
        particle.angleZ = Math.random() * 6;
        particle.angleSpeed = 0.0035 * frameLength * (0.8 + Math.random() * 0.4);
        return particle;
    }
    
    for (let i = 0; i < 30; i++) {
        particles.push(generateParticle());
    }
    let start = new Date().getTime();
    particleInterval = setInterval(() => {
        effectsContainer.show();
        if ((particles.length < 100) && (Math.random() < 0.7) && (new Date().getTime() - start < 10000)) {
            particles.push(generateParticle());
        }
        if (particles.length === 0) {
            clearInterval(particleInterval);
        }
        for (let i = particles.length - 1; i >= 0; i--) {
            let particle = particles[i];
            particle.newConfetti.css("display", "");
            particle.newConfetti.css("left",
                particle.position[0] + particle.twirlAmpl * (1.2 + Math.sin(particle.angleY) * 0.4) * 2 * Math.sin(particle.angleX) + "px");
            let top = particle.position[1] + particle.twirlAmpl * (1.2 + Math.sin(particle.angleY) * 0.4) * (Math.cos(particle.angleX) * 0.6*Math.sin(particle.angleX));
            particle.newConfetti.css("top", top + "px");
            particle.newConfetti.css("transform", "rotateX(" + particle.angleX + "rad) rotateY(" + particle.angleY + "rad) rotateZ(" + particle.angleZ + "rad)")
            particle.position[0] += particle.velocity[0];
            particle.position[1] += particle.velocity[1];
            particle.velocity[0] *= particle.drag;
            particle.velocity[1] = Math.min(particle.terminal, particle.velocity[1] * particle.drag + particle.gravity);
            particle.angleX -= particle.angleSpeed;
            particle.angleY -= particle.angleSpeed * 0.6;
            particle.angleZ -= particle.angleSpeed * 0.4;
            if (top > offsetHeight + 30) {
                particle.newConfetti.remove();
                particles.splice(i, 1);
            }
        }
    }, frameLength)
}



function createSocket() {
    $("#error").css("transform", "scale(0)")
    $("#error").css("pointer-events", "none")
    $("#loading").css("transform", "scale(1)")
    let suggestionBar = $("#suggestion-bar")
    suggestionBar.empty().hide();
    $("#tasks").empty().hide();
    $("#header").hide();
    $("#status-bar").hide();
    $("#address-bar").hide();
    socket = new WebSocket("ws://todo.local:2048", ["remote-protocol"]);
    socket.onopen = ev => {
        socketError = 0;
        socket.send(JSON.stringify({code: "SETTINGS"}))
    };
    socket.onmessage = function (evt) {
        let object = JSON.parse(evt.data);
        switch (object.code) {
            case "SETTINGS": {
                socket.send(JSON.stringify({code: "FOLDERS", path: object.settings.lastPath}))
                break;
            }
            case "FOLDERS": {
                $("#loading").css("transform", "scale(0)")
                $("#address-bar").show().find(".sub-folder").remove();
                path = object.path.split("/").filter(a => a !== "").map((a, index) => {
                    
                    let folder = {name: a}
                    folder.selected = true;
                    folder.visible = true;
                    folder.element = $("<span class='sub-folder'></span>").text(folder.name)
                    folder.element.css("order", index);
                    adjustSubFolder(folder, index, false)
                    $("#address-bar").append(folder.element);
                    return folder
                });
                $("#address").css("order", path.length + 2).val("").focus()
                $("#address-space").css("order", path.length + 2)
                $("#address-close").css("order", path.length + 3)
                setupFolders(object.children, path.length, object.hasTodo);
                break;
            }
            case "TODOS": {
                let tasks = $("#tasks");
                tasks.css("display", "none");
                todos = object.todos;
                days = object.days;
                setupLines();
                $(".task-line.header>.task-line-creation").removeClass("sort-asc").click();
                tasks.css("display", "");
                $("#header").show();
                $("#status-bar").show();
                break;
            }
        }
    }
    socket.onclose = () => {
        if (socketError <= 10) {
            setTimeout(createSocket, socketError * 100);
        } else {
            $("#loading").css("transform", "scale(0)")
            $("#error")
                .css("transform", "scale(1)")
                .css("pointer-events", "all")
        }
    }
    socket.onerror = (err) => {
        socketError++
    }
}

window.onload = () => {
    $("#address")
        .on("input", () => {
            let address = $("#address");
            if (blocked) {
                address.val("")
                return;
            }
            let filter = address.val();
            let selectedIndex = subFolders.findIndex(a => a.selected);
            subFolders.forEach(folder => {
                folder.visible = folder.name.toUpperCase().startsWith(filter.toUpperCase());
                folder.selected = folder.selected && folder.visible;
                adjustSubFolder(folder)
            })
            if (selectedIndex !== -1) {
                if (subFolders[selectedIndex].visible === false) {
                    let found = false;
                    for (let i = selectedIndex; i < subFolders.length; i++) {
                        if (subFolders[i].visible) {
                            subFolders[i].selected = true;
                            adjustSubFolder(subFolders[i]);
                            todoElement.removeClass("selected")
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        for (let i = selectedIndex; i >= 0; i--) {
                            found = false
                            if (subFolders[i].visible) {
                                subFolders[i].selected = true;
                                adjustSubFolder(subFolders[i]);
                                todoElement.removeClass("selected")
                                found = true;
                                break;
                            }
                            if (!found) {
                                todoElement.addClass("selected")
                            }
                        }
                    }
                }
            } else {
                for (let i = 0; i < subFolders.length; i++) {
                    if (subFolders[i].visible) {
                        subFolders[i].selected = true;
                        adjustSubFolder(subFolders[i]);
                        todoElement.removeClass("selected")
                        break;
                    }
                }
            }
        })
        .on("keydown", (e) => {
            if (e.key === "Tab") {
                e.preventDefault();
            }
            e.target.lastText = $(e.target).val();
        })
        .on("keyup", (e) => {
            if (blocked) {
                return;
            }
            switch (e.key) {
                case "Tab": {
                    let selectedIndex = subFolders.findIndex(a => a.selected);
                    if (selectedIndex !== -1) {
                        subFolders[selectedIndex].selected = false;
                        adjustSubFolder(subFolders[selectedIndex]);
                    } else {
                        todoElement.removeClass("selected")
                    }
                    if (!e.shiftKey) {
                        for (let i = selectedIndex + 1; i <= subFolders.length + selectedIndex; i++) {
                            if (subFolders.length === i) {
                                todoElement.addClass("selected")
                                break;
                            } else if (subFolders[i % subFolders.length].visible) {
                                subFolders[i % subFolders.length].selected = true;
                                adjustSubFolder(subFolders[i % subFolders.length]);
                                break;
                            }
                        }
                    } else {
                        if (selectedIndex === -1) {
                            selectedIndex = subFolders.length;
                        }
                        for (let i = subFolders.length + selectedIndex - 1; i >= selectedIndex; i--) {
                            if (subFolders.length - 1 === i) {
                                todoElement.addClass("selected")
                                break;
                            } else if (subFolders[i % subFolders.length].visible) {
                                subFolders[i % subFolders.length].selected = true;
                                adjustSubFolder(subFolders[i % subFolders.length]);
                                break;
                            }
                        }
                    }
                    break;
                }
                case "Enter": {
                    let selectedIndex = subFolders.findIndex(a => a.selected);
                    if (selectedIndex !== -1) {
                        let folder = {name: subFolders[selectedIndex].name}
                        folder.selected = true;
                        folder.visible = true;
                        folder.element = $("<span class='sub-folder'></span>").text(folder.name)
                        folder.element.css("order", path.length + 1);
                        adjustSubFolder(folder, path.length, false)
                        $("#address-bar").append(folder.element)
                        $("#address").css("order", path.length + 2).val("")
                        $("#address-space").css("order", path.length + 2)
                        $("#address-close").css("order", path.length + 3)
                        path.push(folder);
                        let suggestionBar = $("#suggestion-bar")
                        suggestionBar.empty()
                        subFolders = [];
                        blocked = true;
                        socket.send(JSON.stringify({code: "FOLDERS", path: "/" + path.map(a => a.name).join("/")}))
                    } else {
                        socket.send(JSON.stringify({code: "OPEN", path: "/" + path.map(a => a.name).join("/")}))
                        $("#suggestion-bar").hide();
                        $("#address").hide();
                        $("#address-space").show();
                        $("#address-close").show();
                        blocked = true;
                        open = true;
                    }
                    break;
                }
                case "Backspace": {
                    if ((e.target.lastText === "") && (path.length > 0)) {
                        let toDelete = path.pop();
                        toDelete.element.remove();
                        $("#address").css("order", path.length + 2).val("")
                        $("#address-space").css("order", path.length + 2)
                        $("#address-close").css("order", path.length + 3)
                        let suggestionBar = $("#suggestion-bar")
                        suggestionBar.empty()
                        subFolders = [];
                        blocked = true;
                        socket.send(JSON.stringify({code: "FOLDERS", path: "/" + path.map(a => a.name).join("/")}))
                    }
                    break;
                }
            }
        })
    $("#address-close").click(() => {
        let suggestionBar = $("#suggestion-bar")
        suggestionBar.empty()
        $("#tasks").empty().hide();
        $("#header").hide();
        $("#status-bar").hide();
        todos = {};
        days = {};
        subFolders = [];
        blocked = true;
        socket.send(JSON.stringify({code: "FOLDERS", path: "/" + path.map(a => a.name).join("/")}))
    })
    let toggleHeaderSorting = (headerName, positiveComparator) => () => {
        if (open) {
            let header = $(".task-line.header>.task-line-" + headerName);
            $(".task-line.header>span").not(".task-line-" + headerName).removeClass("sort-asc").removeClass("sort-desc");
            if (header.hasClass("sort-asc")) {
                header.removeClass("sort-asc");
                header.addClass("sort-desc");
                orderTodos((taskA, taskB) => -positiveComparator(taskA, taskB));
            } else {
                header.removeClass("sort-desc");
                header.addClass("sort-asc");
                orderTodos((taskA, taskB) => positiveComparator(taskA, taskB));
            }
        }
    }
    $(".task-line.header>.task-line-name")
        .on(
            "click",
            toggleHeaderSorting("name", (taskA, taskB) => taskA.name.localeCompare(taskB.name))
        );
    $(".task-line.header>.task-line-creation")
        .on(
            "click",
            toggleHeaderSorting("creation", (taskA, taskB) => {
                return compareTimes(taskA.creation, taskB.creation);
            })
        )
    $(".task-line.header>.task-line-running")
        .on(
            "click",
            toggleHeaderSorting("running", (taskA, taskB) => {
                return compareTimes(taskA.running, taskB.running);
            })
        )
    
    
    $(".task-line.header>.task-line-completion")
        .on(
            "click",
            toggleHeaderSorting("completion", (taskA, taskB) => {
                return compareTimes(taskA.completion, taskB.completion);
            })
        )
    $(".task-line.header>.task-line-weight")
        .on(
            "click",
            toggleHeaderSorting("weight", (taskA, taskB) => taskA.weight - taskB.weight)
        )
    $(".task-line.header>.task-line-counter")
        .on(
            "click",
            toggleHeaderSorting("counter", (taskA, taskB) => taskA.timeSpent - taskB.timeSpent)
        )
    $(".task-line.header>.task-line-status")
        .on(
            "click",
            toggleHeaderSorting("status", (taskA, taskB) => {
                let number = taskA.status - taskB.status;
                if (number !== 0) {
                    return number;
                } else {
                    return compareTimes(taskA.creation, taskB.creation);
                }
            })
        )
    $("#status-add").click(() => {
        if (open) {
            let dialog = $(
                '<div class="modal">' +
                '<div class="modal-content">' +
                '<h4 class="no-select">Edit ToDo</h4>' +
                '<div class="input-field col s6" style="margin-top: 30px; margin-bottom: 0">\n' +
                '<input id="title" data-error="Please insert a valid title" type="text">\n' +
                '<label for="title">Title</label>\n' +
                '<span class="helper-text" data-error="Please insert a valid title">Insert a title for the ToDo</span>' +
                '</div> ' +
                '<div class="input-field col s6" style="margin-top: 30px; margin-bottom: 0">\n' +
                '<input id="weight" data-error="Please insert a valid number" type="text">\n' +
                '<label for="weight">Weight</label>\n' +
                '<span class="helper-text" data-error="Please insert a valid weight">Insert a weight signifying the ToDo difficulty</span>' +
                '</div> ' +
                '<div class="input-field col s6" style="margin-top: 20px; margin-bottom: 0">' +
                '<textarea id="description" class="materialize-textarea" style="height: 100px"></textarea>' +
                '<label for="description">Description</label>\n' +
                '</div> ' +
                '</div>' +
                '<div class="modal-footer">' +
                '<a class="button white-text" style="background-color: #8b65fd" id="ok-btn">OK</a>' +
                '<a class="modal-close button white-text">Cancel</a>' +
                '</div>' +
                '</div>');
            let weight = dialog.find("#weight");
            weight
                .val(1)
                .on("input", () => {
                    if (!/$[0-9.]*^/.test(weight.val())) {
                        weight.val(weight.val().replace(/[^0-9.]/, ""));
                    }
                })
                .keydown((e) => {
                    let delta = 0;
                    if (e.key === "ArrowUp") {
                        delta = 1;
                    } else if (e.key === "ArrowDown") {
                        delta = -1;
                    }
                    if (delta !== 0) {
                        e.preventDefault();
                        let i = parseFloat(weight.val());
                        if (!isNaN(i) && isFinite(i)) {
                            if (e.shiftKey) {
                                weight.val(Math.max(1, i + 10 * delta))
                            } else {
                                weight.val(Math.max(1, i + delta))
                            }
                        }
                    }
                    
                });
            dialog.find("#ok-btn").click(() => {
                let todo = {
                    creation: getNumbersFromDate(new Date()),
                    completion: null,
                    running: null
                }
                let newTitle = dialog.find("#title").val();
                if (newTitle !== "") {
                    todo.name = newTitle.replace(/[\n\r]/, "");
                    dialog.find("#title").removeClass("invalid")
                } else {
                    dialog.find("#title").addClass("invalid");
                    return;
                }
                let newWeight = parseFloat(dialog.find("#weight").val());
                if (!isNaN(newWeight) && isFinite(newWeight)) {
                    todo.weight = newWeight;
                    dialog.find("#weight").removeClass("invalid");
                } else {
                    dialog.find("#weight").addClass("invalid");
                    return;
                }
                todo.desc = dialog.find("#description").val();
                let maxWeight = getMaxWeight();
                for (let someTodo of Object.values(todos)) {
                    todoNewValues(someTodo, maxWeight)
                }
                let newID = Object.keys(todos).map(a => parseInt(a)).reduce((a, b) => Math.max(a, b)) + 1;
                socket.send(JSON.stringify({
                    code: "ADD_TODO",
                    id: newID,
                    path: "/" + path.map(a => a.name).join("/"),
                    "todo": todo
                }))
                todos[newID] = todo;
                setupLines();
                M.Modal.getInstance(dialog).close();
            })
            $("body").append(dialog)
            dialog.modal({onCloseEnd: () => dialog.remove()});
            M.updateTextFields();
            M.Modal.getInstance(dialog).open();
        }
    })
    
    path = [{
        "name": "Users",
        "selected": true,
        "visible": true,
        "element": {"0": {}, "length": 1}
    }, {
        "name": "asteriofiora",
        "selected": true,
        "visible": true,
        "element": {"0": {}, "length": 1}
    }, {
        "name": "WebstormProjects",
        "selected": true,
        "visible": true,
        "element": {"0": {}, "length": 1}
    }, {"name": "tasks", "selected": true, "visible": true, "element": {"0": {}, "length": 1}}]
    
    createSocket();
}
