/*
This file is part of the Ryte project.

Copyright (C) 2026 Ryte contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import WebView from "react-native-webview";
import { bridge } from "./bridge";

/**
 * Runs MEGA and Filen (packages/ryte-cloud) in a hidden WebView, because
 * their libraries need the browser's WebCrypto, which React Native lacks.
 * The page is android/app/src/main/assets/ryte-bridge.html.
 */
export function RyteBridgeHost() {
  const ref = useRef<WebView>(null);
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    RNFetchBlob.fs
      .readFile(RNFetchBlob.fs.asset("ryte-bridge.html"), "utf8")
      .then(setHtml)
      .catch((e) => console.error("Ryte: could not load cloud bridge", e));
    bridge.attach((script) => ref.current?.injectJavaScript(script));
  }, []);

  if (!html) return null;

  const restart = () => {
    bridge.detach();
    ref.current?.reload();
  };

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        opacity: 0,
        left: -10,
        top: -10
      }}
    >
      <WebView
        ref={ref}
        // an https origin gives the page WebCrypto (a secure context)
        source={{ html, baseUrl: "https://ryte.local/" }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        onMessage={(event) => bridge.onMessage(event.nativeEvent.data)}
        onLoadStart={() => bridge.detach()}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
    </View>
  );
}
