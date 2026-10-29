package javax.security.sasl;

import java.io.IOException;

/** The JDK's SASL failure, which Android leaves out; see {@link SaslClient}. */
public class SaslException extends IOException {
  private static final long serialVersionUID = 4579784287983423626L;

  public SaslException() {
    super();
  }

  public SaslException(String detail) {
    super(detail);
  }

  public SaslException(String detail, Throwable ex) {
    super(detail, ex);
  }
}
