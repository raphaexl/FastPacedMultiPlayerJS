
class NetworkLag{
    constructor(){
        this.messages = [];
    }

    //recv_ts when it should be received to simulate lag
    send(lag_msg, message){
        this.messages.push({recv_ts : +new Date() + lag_msg, payload: message});
    }

    receive(){
        const now = +new Date();
        for (let i = 0; i < this.messages.length; i++){
            const msg = this.messages[i];
            if (msg.recv_ts <= now){ //time to receive it
                this.messages.splice(i, 1);
                return msg.payload;
            }
        }
    }
}

class Entity{
    constructor(){
        this.x = 0;
        this.speed = 2;
        this.position_buffer = [];
    }

    applyInput(input){
        this.x += input.press_time * this.speed;
    }
}

class Client{
    constructor(canvas, status){
        this.entities = {}; //local representation of the entities
        this.key_left = false;
        this.key_right = false;

        //Simulate network connection
        this.network = new NetworkLag();
        this.server = null;
        this.lag = 0;

        this.entity_id = null;

        //Needed for reconciliation
        this.client_side_prediction = false;
        this.server_reconciliation = false;
        this.input_sequence_number = 0;
        this.pending_inputs = [];

        //the other entities entity interpolation ?
        this.entity_interpolation = true;

        this.canvas = canvas;
        this.status = status;

        this.setUpdateRate(50);
    }
    
    setUpdateRate(hz){
        this.update_rate = hz;
        
        clearInterval(this.update_interval);
        this.update_interval = setInterval( this.update.bind(this), 1000/this.update_rate);
       
    }

    update(){

        //Listen to the server
        this.processServerMessages();
        if (this.entity_id == null){return ;} //Not connected
        //process inputs
        this.processInputs();
        //if we should interpolate interpolate
        if (this.entity_interpolation){
            this.interpolateEntities();
        }
        //renderThe World
        
        renderWorld(this.canvas, this.entities);
     

        const info = "Non-aknowledgement inputs : " + this.pending_inputs.length;
        this.status.textContent = info;
    }

    //Get input and send them to the server and if the client side prediction is enable apply them on the client(do it)
  
    processInputs(){
        const now_ts = +new Date();
        const last_ts = this.last_ts || now_ts;
        const dt_sec = (now_ts - last_ts)/1000.0;
        this.last_ts = now_ts;

        let input;
        if (this.key_right){
            input = {press_time: dt_sec}
        }else if (this.key_left){
            input = {press_time: -dt_sec}
        }else{
            return ; //Nothing interesting happened
        }
        //Send the input to the server

        input.input_sequence_number = this.input_sequence_number++;
        input.entity_id = this.entity_id;
        this.server.network.send(this.lag, input);

        //Client side prediction
        if (this.client_side_prediction){
            this.entities[this.entity_id].applyInput(input);
        }
        //Save the input for later reconciliation
        this.pending_inputs.push(input);
    }

    processServerMessages(){
        while(true){
            const msg = this.network.receive();
            if (!msg){ break ;}
            //World state is a list of entities state
            for (let i = 0; i < msg.length; i++){
                const state = msg[i];

                //If for the first time create the entity
                if (!this.entities[state.entity_id]){
                    const entity = new Entity();
                    entity.entity_id = state.entity_id;
                    this.entities[state.entity_id] = entity;
                }

                const entity = this.entities[state.entity_id];
                if (state.entity_id === this.entity_id){
                    //Received authorative position of this client's entity
                    entity.x = state.position;

                    if (this.server_reconciliation){ //Re-apply all input not porcessed by the server
                        let j = 0;
                        while (j < this.pending_inputs.length){
                            const input = this.pending_inputs[j];
                            if (input.input_sequence_number <= state.last_processed_input){
                                //Already procced, drop it
                                this.pending_inputs.splice(j, 1);
                            }else{
                                //Not procced yet by the server reapply it
                                entity.applyInput(input);
                                j++;
                            }
                        }
                    }else{
                        //Reconciliation disabled drop all of the inputs
                        this.pending_inputs = [];                        
                    }
                }else{
                    //Received input of entity other than client
                    if (!this.entity_interpolation){
                        entity.x = state.position;
                    }else{
                        //Add it to the position buffer
                        const timestamp = +new Date();
                        entity.position_buffer.push([timestamp, state.position]);
                    }
                }
            }
        }
    }

    interpolateEntities(){
        //Compute render timestamp
        const now = +new Date();
        const render_timestamp = now - 1000.0 / this.server.update_rate;

        for (let i in this.entities){
            const entity = this.entities[i];

            if (entity.entity_id === this.entity_id){
                continue ;// We don't interpolate this client
            }
            //Find two authorative position surrounding the rendering timestep
            const buffer = entity.position_buffer;

            //Drop older position
            while(buffer.length >= 2 && buffer[1][0] <= render_timestamp){
                buffer.shift();
            }
            if (buffer.length >= 2 && buffer[0][0] <= render_timestamp && render_timestamp <= buffer[1][0]){
                const x0 = buffer[0][1];
                const x1 = buffer[1][1];
                const t0 = buffer[0][0];
                const t1 = buffer[1][0];

                entity.x = x0 + (x1 - x0) * (render_timestamp - t0) / (t1 - t0); 
            }
        }
    }
}

class Server{
    constructor(canvas, status){
        //connected clients and their entities
        this.clients = [];
        this.entities = [];
        //last processed input foreach client
        this.last_processed_input = [];
        //Simulate network lag
        this.network = new NetworkLag();

        this.canvas = canvas;
        this.status = status;

        this.setUpdateRate(10);
    }
    
    connect(client){
        client.server = this;
        client.entity_id = this.clients.length;
        this.clients.push(client);
        const entity = new Entity();
        this.entities.push(entity);
        entity.entity_id = client.entity_id;

        const spawn = [4, 6];
        entity.x = spawn[client.entity_id];
    }

    setUpdateRate(hz){
        this.update_rate = hz;
        clearInterval(this.update_interval);
        this.update_interval = setInterval(
            this.update.bind(this), 1000/this.update_rate);
    }

    update(){
        this.processInputs();
        this.sendWorldState();
        renderWorld(this.canvas, this.entities);                
    }
    //Check input validity according to the game rules
    validateInput(input){
        if (Math.abs(input.press_time) > 1 / 40){
            return false;
        }
        return true;
    }

    processInputs(){
        //process all pending messages from the client
        while (true){
            const msg = this.network.receive();
            if (!msg){break ;}
            //Update the state of the entity based on valide input ignoring invalid one
            if (this.validateInput(msg)){
                const id = msg.entity_id;
                this.entities[id].applyInput(msg);
                this.last_processed_input[id] = msg.input_sequence_number;
            }
        }

        const info = "Last aknowledged inputs : ";
        for(let i = 0; i < this.clients.length; i++){
            info + " Player : " + i + " #" + (this.last_processed_input[i] ||  0 + " ");
        }
        this.status.textContent = info;
    }

    //Send the world state to all connected clients
    sendWorldState(){
        //Gather the state of the world. in real app state could be filtered to avoid leaking data
        //eg : position of the invisible enemies
        let world_state = [];
        const num_clients = this.clients.length;
        for (let i = 0; i < num_clients; i++){
            const entity = this.entities[i];
            world_state.push({entity_id: entity.entity_id, position: entity.x, last_processed_input: this.last_processed_input[i]});
        }

        //Brodcast to all the the clients
        for (let i = 0; i < num_clients; i++){
            const client = this.clients[i];
            client.network.send(client.lag, world_state);
        }
    }
}

const renderWorld = (canvas, entities) => {
    //clear canvas
    canvas.width = canvas.width;
    const colours = ["blue", "red"];
    for (let i in entities){

        const entity = entities[i];
        const radius = canvas.height * 0.9 / 2;
        const x = (entity.x / 10) * canvas.width;

        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(x, canvas.height / 2, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = colours[entity.entity_id];
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'dark' + colours[entity.entity_id];
        ctx.stroke();
    }
   // debugger
}

let server_fps = 4;

const updateParameters = () => {
    updatePlayerParameters(player1, "player1");
    updatePlayerParameters(player2, "player2");
    server.setUpdateRate(updateNumberFromUI(server.update_rate, "server_fps"));
    return true;
}

const updatePlayerParameters = (client, prefix) => {
    client.lag = updateNumberFromUI(player1.lag, prefix + '_lag');
    const cb_prediction = element(prefix + '_prediction'); 
    const cb_reconciliation = element(prefix + '_reconciliation');
    //Client side predition disabled => disable server reconciliation as well
    if (client.client_side_prediction && !cb_prediction.checked){
        cb_reconciliation.checked = false;
    }
    //Server reconciliation enabled => enable client side predicition
    if (!client.server_reconciliation && cb_reconciliation.checked){
        cb_prediction.checked = true;
    }

    client.client_side_prediction = cb_prediction.checked;
    client.server_reconciliation = cb_reconciliation.checked;

    client.entity_interpolation = element(prefix + '_interpolation').checked;
}

const updateNumberFromUI = (old_value, element_id) => {
    const input = element(element_id);
    const new_value = parseInt(input.value);
    if (isNaN(new_value)){
        new_value = old_value;
    }
    input.value = new_value;
    return new_value;
}

const keyHandler  = (e) => {
    e = e || window.event;
    if (e.keyCode == 39){
        player1.key_right = (e.type == 'keydown');
    } 
    if (e.keyCode == 37){
        player1.key_left = (e.type == 'keydown');
    } if (e.key == 'd'){
        player2.key_right = (e.type == 'keydown');
    } if (e.key == 'a'){
        player2.key_left = (e.type == 'keydown');
    } 
}

const element = function(id) {
    return document.getElementById(id);
  }
  

document.body.onkeydown = keyHandler;
document.body.onkeyup = keyHandler;

const server = new Server(element('server_canvas'), element('server_status'));
const player1 = new Client(element('player1_canvas'), element('player1_status'));
const player2 = new Client(element('player2_canvas'), element('player2_status'));

server.connect(player1);
server.connect(player2);
updateParameters();
