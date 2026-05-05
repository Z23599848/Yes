# AI Coder Prompt Addendum

## Handle SMS verification

- After the wrapper script asks for the Bale phone number, it must also prompt
  the user to enter the one-time verification code (OTP) sent by Bale via SMS.
  The wrapper must not log or store this code beyond the current session.
- In the Puppeteer login automation for both `master/tunnel.js` and
  `slave/tunnel.js`, implement steps to:

  1. Navigate to `https://web.bale.ai/` and detect the phone-number input field.
  2. Type the provided phone number and submit the form to trigger the SMS.
  3. Pause and prompt the user in the terminal to enter the received SMS code.
  4. Locate the OTP input field in the Bale web UI and type the provided code,
     then submit it to complete login.

- Only after a successful login should the script proceed to search for the
  contact, initiate the call on the slave, or accept it on the master, then
  capture and save the LiveKit token as previously described.
- The wrapper must handle edge cases such as invalid codes or timeouts by
  allowing the user to retry entering the SMS code.
