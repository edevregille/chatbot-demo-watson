var cfenv = require("cfenv");
var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');
var watson = require('watson-developer-cloud');
var extend = require('util')._extend;
var settings = require('./configuration.js');

var dialogCredentials =  extend({
  // used when running locally
  url: settings.dialog_url,
  username: settings.dialog_username,
  password: settings.dialog_pwd,
  version: settings.dialog_version
}, getBluemixCredentials('dialog'));

var nLCCredentials =  extend({
  // used when running locally
  url: settings.nlc_url,
  username: settings.nlc_username,
  password: settings.nlc_pwd,
  version: settings.nlc_version
}, getBluemixCredentials('natural_language_classifier'));

// Watson services names
var dialog_id, dialog_name = settings.dialog_name;
var classifier_id, classifier_name =settings.nlc_name;

//initialize watson sdk
var dialog = watson.dialog(dialogCredentials);
var natural_language_classifier = watson.natural_language_classifier(nLCCredentials);

// Facebook authentication settings
var token = settings.facebook_token;
var secret = settings.facebook_secret;

//senders is used to store session information. Better to use a database or to have the chat front-end to provide the conversation_ID and dialog_ID
var conversations = {};

var appEnv = cfenv.getAppEnv();
var app = express();
app.use(bodyParser.json());

//webhook to facebook messaging Platform
app.get('/webhook/', function (req, res) {
  if (req.query['hub.verify_token'] === secret) {
    res.send(req.query['hub.challenge']);
  }
  res.send('Error, wrong validation token');
});

//new messages coming from Facebook
app.post('/webhook/', function (req, res) {
  messaging_events = req.body.entry[0].messaging;
  console.log('INFO - New Message received from Facebook Messenger: ' + JSON.stringify(messaging_events));
  for (i = 0; i < messaging_events.length; i++) {
    event = req.body.entry[0].messaging[i];
    processNewMessage(event);
  }
  res.sendStatus(200);
});

//retrieve the NLC classifier ID
natural_language_classifier.list({}, function(error, response){
  if (error){
    console.log('error',error);
  }
  else{
    var temp = response.classifiers;
    for (var i=0; i<temp.length;i++){
      if(temp[i].name===classifier_name)
        classifier_id = temp[i].classifier_id;
    }
    console.log('INFO - this is the NLC classifier id: '+classifier_id);
  }
});

//retrive the dialog xml model ID
dialog.getDialogs({}, function(err,response){
  if (err) console.log('error', err);
  else {
    var temp = response.dialogs;
    for (var i=0; i<temp.length;i++){
      if(temp[i].name===dialog_name) dialog_id = temp[i].dialog_id;
    }
    console.log('INFO - this is the dialog ID service: '+ dialog_id);
  }
})

//function to invoke NLC when new fb message incoming
function processNewMessage(event) {
  var sender = event.sender.id;
  var text;
  if (event.postback && event.postback.payload) {
    text = event.postback.payload;
    if (text) {
      if (text === 'hi') {
        senders[sender] = { client_id: '', conversation_id: ''};
      }
    }
    invokeDialog(text, sender);
  }
  else if (event.message && event.message.text) {
    text = event.message.text;
    natural_language_classifier.classify({
      text: text,
      classifier_id: classifier_id
    }, function(err, response) {
        if (err) {
          console.log(err);
          sendTextMessage(sender, "Error occured in Watson Natural Language Classifier service");
        }
        else {
          if (response && response.classes && response.classes.length >1) {
            console.log('INFO - the input text was ' + text + ' and Watson NLC answer is ' + response.classes[0].class_name + ' with a confidence of '+response.classes[0].confidence);
            var intent_class = response.classes[0].class_name.split('-');
            if ((response.classes[0].confidence > 0.7)&&(intent_class[1]!=='off')) {
              invokeDialog(response.classes[0].class_name, sender);
            }
            else {
              invokeDialog(text, sender);
            }
          }
          else {
            invokeDialog(text, sender);
          }
        }
      });
    }
}


function getBluemixCredentials(name) {
  if (process.env.VCAP_SERVICES) {
    var services = JSON.parse(process.env.VCAP_SERVICES);
    for (var service_name in services) {
      if (service_name.indexOf(name) === 0) {
        var service = services[service_name][0];
        return {
          url: service.credentials.url,
          username: service.credentials.username,
          password: service.credentials.password
        };
      }
    }
  }
  return {};
};

//function to interact with Dialog services
function invokeDialog(text, sender) {
  if (text) {
    if (!conversations[sender])
      conversations[sender] = { client_id: '', conversation_id: ''};

    var params = {
      conversation_id: conversations[sender].conversation_id,
      dialog_id: dialog_id,
      client_id: conversations[sender].client_id,
      input: text
    };
    console.log('INFO - calling dialog API with following parameters: ' + JSON.stringify(params));
    dialog.conversation(params, function(err, results) {
      if (err) {
        console.log(err);
        sendMessage(sender, "Error occured in Watson Dialog service");
      }
      else {
        console.log('INFO - here is the result of conversation API call: '+ JSON.stringify(results));
        conversations[sender] = {
          client_id: results.client_id,
          conversation_id: results.conversation_id
        };
        sendMessage(sender, results.response[0]);
      }
    });
  }
}

//function to publish a response on FB messager
function sendMessage(recipient, text) {
  request({
    url: 'https://graph.facebook.com/v2.6/me/messages',
    qs: {access_token:token},
    method: 'POST',
    json: {
      recipient: {id:recipient},
      message: {
        text:text
      }
    }
  },
  function(error, response, body) {
    if (error) {
      console.log('Error sending message: ', error);
    } else if (response.body.error) {
      console.log('Error: ', response.body.error);
    }
  });
}


app.listen(appEnv.port, appEnv.bind, function() {
  console.log('listening on port ' + appEnv.port);
});
