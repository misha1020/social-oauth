async function exchangeCode({
  code,
  codeVerifier,
  deviceId,
  redirectUri,
  clientId
}) {
  console.log("code: ", code);
  console.log("codeVerifier: ", codeVerifier);
  console.log("deviceId: ", deviceId);
  console.log("redirectUri: ", redirectUri);
  console.log("clientId: ", clientId);
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    device_id: deviceId,
    redirect_uri: redirectUri
  });

  const res = await fetch("https://id.vk.ru/oauth2/auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return {
    accessToken: data.access_token,
    userId: data.user_id,
    idToken: data.id_token || null
  };
}

async function fetchUserProfile(accessToken, clientId, deviceId) {
  const params = new URLSearchParams({
    access_token: accessToken,
    device_id: deviceId
  });

  const res = await fetch(
    `https://id.vk.ru/oauth2/user_info?client_id=${encodeURIComponent(clientId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    }
  );
  const data = await res.json();

  if (data.error) {
    throw new Error(data.error || "VK API error");
  }

  const user = data.user;
  return {
    vkId: parseInt(user.user_id, 10),
    firstName: user.first_name,
    lastName: user.last_name
  };
}

module.exports = { exchangeCode, fetchUserProfile };
