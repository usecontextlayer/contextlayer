// Any keypress accepts — the empty response ends the whisper, which is
// Twilio's signal to bridge the two legs.
exports.handler = (_context, _event, callback) => {
	callback(null, new Twilio.twiml.VoiceResponse())
}
