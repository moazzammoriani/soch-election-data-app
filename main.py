from pydantic import BaseModel, Field, ConfigDict, model_validator
from typing import Literal, Optional
from enum import Enum


class VoteType(str, Enum):
    regular = "regular"
    crossed = "crossed"
    crossed_and_corrected = "crossedAndCorrected"
    overwritten = "overwritten"
    illegible = "illegible"
    blank = "blank"


class VoteValue(BaseModel):
    """A vote value that can be regular, crossed, corrected, overwritten, illegible, or blank."""
    type: VoteType = Field(description="The type/status of this vote value")
    value: Optional[int] = Field(
        default=None,
        description="The numeric value. Required for regular/crossedAndCorrected/overwritten types, null for others."
    )

    @model_validator(mode="after")
    def validate_value_presence(self):
        types_requiring_value = {VoteType.regular, VoteType.crossed_and_corrected, VoteType.overwritten}
        if self.type in types_requiring_value and self.value is None:
            raise ValueError(f"value is required when type is {self.type.value}")
        return self

# Main schema
class ElectionForm(BaseModel):
    total_registered_voters: VoteValue = Field(
        alias="Total Registered Voters (First row 'Kul Tadaad') (could also be empty)"
    )
    farooq_sattar_col3: VoteValue = Field(
        alias="Farooq Sattar(row 23) Votes column 3"
    )
    farooq_sattar_col6: VoteValue = Field(
        alias="Farooq Sattar(row 23) Votes column 6"
    )
    aftab_jehangir_col3: VoteValue = Field(
        alias="Aftab Jehangir (row 1) Votes column 3"
    )
    aftab_jehangir_col6: VoteValue = Field(
        alias="Aftab Jehangir (row 1)  Votes column 6"
    )
    row_a: VoteValue = Field(alias="Row A")
    row_b: VoteValue = Field(alias="Row B")
    row_c: VoteValue = Field(alias="Row C")
    row_d: VoteValue = Field(alias="Row D (left-most number only)")

    model_config = ConfigDict(populate_by_name=True)


# Print the JSON schema
if __name__ == "__main__":
    import json
    import base64
    import os
    import fitz  # pymupdf
    from google import genai

    # Convert first two PDF pages to images
    pdf_path = "NA-244.pdf"
    doc = fitz.open(pdf_path)

    images = []
    for page_num in range(min(2, len(doc))):
        page = doc[page_num]
        pix = page.get_pixmap(dpi=150)
        img_bytes = pix.tobytes("png")
        images.append(img_bytes)
    doc.close()

    # Initialize Gemini client
    client = genai.Client()

    # Create the prompt
    prompt = """Analyze this election form and extract the values into the specified schema.
For each field, determine if the value is:
- "regular": A clear, unmodified number
- "crossed": The value has been crossed out
- "crossedAndCorrected": Crossed out with a new value written
- "overwritten": Written over with a different value
- "illegible": Cannot be read clearly
- "blank": No value present

Extract the data according to the field names in the schema."""

    # Build content with images
    contents = [prompt]
    for img_bytes in images:
        contents.append(
            genai.types.Part.from_bytes(data=img_bytes, mime_type="image/png")
        )

    # Call Gemini with structured output
    response = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=contents,
        config=genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ElectionForm,
        ),
    )

    # Parse response into model
    result = ElectionForm.model_validate_json(response.text)
    print(json.dumps(result.model_dump(), indent=2))
